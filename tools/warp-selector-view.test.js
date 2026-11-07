'use strict';
// T2/T3 + T4 (warp S2,S3,S4,S5,S6,S9,S12,S16; worktree-ui-feedback S4,S12,S15)
// tests: lib/warp-selector-view.js — the warp surface as ONE component with
// two views: the S4 bottom panel
// (title, the current worktree's name, its data line, a separator, up to five
// worktree rows, an optional `view all worktrees` row, the focused worktree's
// data line, the one-row key legend) and the extended list (always-active
// filter row, pagination, `esc` back one level).
//
// Contract under test, as observable output only: every line is exactly the
// requested width; the panel is exactly as tall as its content and never
// taller than the rows the host offers (S3: a bottom panel that computes its
// own height, not a box with slack); the S4 order above is pinned; the current
// worktree owns the header and is never one of the five rows (S4b), and it is
// never a DESTINATION either: `view all worktrees` lists every other checkout
// and never the one the session already stands in; the
// principal leads when it is not current, then the rows follow the most
// recent activity; `view all worktrees` appears only when at least one
// worktree is left out (S4c, reconciled in L2) and never when everything
// fits; the legend is exactly ONE row (S2); S5 rows are the checkout NAMES
// alone (the branch lives in a data line, never repeated on the row); a data
// line carries branch, the change size as LINE COUNTS (S16: bare `+A −D`,
// because the sign already says what the number is — the label survives only
// where the counts are unreadable, as `changes unavailable`),
// `↑N ↓M` and both ages, omits a measured zero for the change size and for
// each of `↑`/`↓`, and says `unavailable` — never `0` — for a fact it cannot
// read, while an unreadable AGE is the brief `—` and never the caller's prose
// reason (S15: the reason stays in the data). S1/S4: a worktree carries no
// issue or ODD association any more and the panel keeps no edit view, so the
// line names neither association (a legacy registry value never
// reaches it) and `e` is NOT a binding; `ctrl+d` asks to delete the focused
// checkout, in both views, and both legends advertise it (the extension owns
// the confirmation and every refusal); the facts are read for the current and the
// focused checkout, at most once each, and render() performs no I/O; `c`
// opens the create flow instead of owning a list row (S6) while `v`,
// `enter`, `r` and `esc` keep their meanings; `esc` steps back one level from
// the list; while the search is active `delete` clears the whole query and
// `backspace` edits one character (S4/S12); no key outside the documented map
// changes state.
//
// The panel frame is pinned: 7 fixed rows (top rule, current name, current
// data, separator, focused data, legend, bottom rule) plus up to five
// worktree rows and the optional `view all worktrees` row. The list frame is
// pinned: 5 fixed rows (top rule, filter, page row, footer, bottom rule) plus
// a page.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWarpSelectorView, formatFactsLine } = require('../lib/warp-selector-view.js');

function strip(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

const helpers = {
  visibleWidth: (text) => [...strip(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text) };

// S11: a theme that RECORDS which role painted each string and paints every
// role with its own SGR code, so a rendered line can be read for the ROLE
// behind a token instead of trusting an eyeballed colour. A role the map does
// not name still gets its own code, so an unexpected role shows up instead of
// passing silently.
const ROLE_SGR = { accent: 96, customMessageLabel: 33, muted: 90, dim: 2, border: 34, error: 91, text: 39, mdHeading: 35 };

function recordingTheme() {
  const calls = [];
  const code = (role) => ROLE_SGR[role] ?? 95;
  return {
    calls,
    fg(role, text) {
      const value = String(text);
      calls.push({ role, text: value });
      return `\x1b[${code(role)}m${value}\x1b[0m`;
    },
    bold(text) {
      const value = String(text);
      calls.push({ role: 'bold', text: value });
      return `\x1b[1m${value}\x1b[22m`;
    },
    bg(role, text) {
      calls.push({ role: `bg:${role}`, text: String(text) });
      return String(text);
    },
  };
}

const WIDTH = 80;
const WIDE = 200;
const HEIGHT = 20;
// Pinned clock: the ages a data line renders are asserted against this
// instant instead of the host's real time.
const NOW = Date.parse('2026-03-01T00:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const CURRENT = { name: 'feat-odd-viewer', path: '/w/feat-odd-viewer', branch: 'feat/odd-viewer' };
const CHECKOUTS = [
  CURRENT,
  { name: 'main', path: '/w/herdr', branch: 'main', isPrincipal: true },
  { name: 'feat-alpha', path: '/w/feat-alpha', branch: 'feat/alpha' },
  { name: 'fix-beta', path: '/w/fix-beta', branch: 'fix/beta' },
];

const DEFAULT_FACTS = { branch: 'feat/alpha', changes: { added: 2, deleted: 1 }, ahead: 1, behind: 0, createdAt: '2026-02-01' };
// S1: a LEGACY registry association still travels in the facts payload (the
// stored data is preserved), and the line must never print it.
const LEGACY_FACTS = { ...DEFAULT_FACTS, issues: [12], assignedOdd: 'odd/tasks/w1-a.md', odd: ['w1-a', 'w2-b'] };
// The same facts rendered, so an assertion names the behaviour, not the
// formatter's punctuation.
const DEFAULT_LINE = 'branch feat/alpha · +2 −1 · ↑1 · created 28d ago · modified —';
// S15: the two ages are the facts that carry a prose reason when they are
// unreadable, so a compact preview line names them with a dash instead of
// repeating that explanation. The reason itself stays in the data.
const NO_AGES = 'created — · modified —';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeView(options = {}) {
  const paints = [];
  const results = [];
  const factCalls = [];
  const reloadCalls = [];
  const toggles = [];
  const factsReader = options.facts || (() => DEFAULT_FACTS);
  const view = createWarpSelectorView({
    checkouts: options.checkouts || CHECKOUTS,
    current: options.current === undefined ? { name: CURRENT.name, path: CURRENT.path } : options.current,
    facts: (path) => {
      factCalls.push(path);
      return factsReader(path);
    },
    reload: options.reload || (() => {
      reloadCalls.push(true);
      return options.reloadTo || options.checkouts || CHECKOUTS;
    }),
    onToggle: options.onToggle ? (path) => {
      toggles.push(path);
      return options.onToggle(path);
    } : undefined,
    canonicalPath: typeof options.canonicalPath === 'function' ? options.canonicalPath : undefined,
    helpers,
    theme: options.theme === undefined ? plainTheme : options.theme,
    now: options.now === undefined ? NOW : options.now,
    rowsAvailable: () => (options.rows === undefined ? HEIGHT : options.rows),
    requestRender: () => { paints.push(true); },
    done: (value) => { results.push(value); },
  });
  return { view, paints, results, factCalls, reloadCalls, toggles };
}

// A view mounted the way the host does it: the mount's own reads have
// settled before the first frame is inspected.
async function opened(options = {}) {
  const made = makeView(options);
  await tick();
  return made;
}

// Strip the frame and return the exact inner text of every content row
// (the frame is `│ <inner> │`, so inner is width-4 wide).
function screen(view, width = WIDTH) {
  const lines = view.render(width).map(strip);
  const rows = lines.map((line) => (line.startsWith('│') ? line.slice(2, -2).replace(/\s+$/, '') : line));
  return { lines, rows };
}

// S4: the panel is pinned, so every region is reachable by position — a
// layout regression then fails ONE named assertion instead of thirty magic
// indices. The list area is whatever sits between the separator and the
// three trailing rows (focused data, legend, bottom rule).
function panel(view, width = WIDTH) {
  const { lines, rows } = screen(view, width);
  const list = rows.slice(4, rows.length - 3);
  return {
    lines,
    rows,
    height: lines.length,
    title: lines[0],
    currentName: rows[1],
    currentData: rows[2],
    separator: rows[3],
    list,
    worktrees: list.filter((text) => !/view all worktrees/.test(text)),
    viewAll: list.find((text) => /view all worktrees/.test(text)) || null,
    focusData: rows[rows.length - 3],
    legend: rows[rows.length - 2],
    bottom: lines[lines.length - 1],
  };
}

function assertWidth(lines, width = WIDTH) {
  for (const line of lines) {
    assert.equal(helpers.visibleWidth(line), width, `not ${width} wide: "${line}"`);
  }
}

describe('bottom panel layout (S3, S4)', () => {
  test('renders the S4 order from top to bottom at a content-fitting height', async () => {
    const { view } = await opened();
    const view80 = panel(view);
    assert.equal(view80.height, 10, 'top + name + data + separator + 3 rows + focused data + legend + bottom');

    const { lines, rows } = screen(view, WIDE);
    assertWidth(lines, WIDE);
    assert.match(lines[0], /^╭─ Warp ─+ esc ─╮$/, 'line 1 is the title line');
    assert.equal(rows[1], 'feat-odd-viewer', 'line 2 is the current session worktree');
    assert.equal(rows[2], DEFAULT_LINE, 'line 3 is that worktree\'s data');
    assert.equal(rows[3], '', 'a separator row follows the header');
    assert.equal(rows[4], '▸ main · use the local project', 'the list starts on line 5, focused first');
    assert.equal(rows[5], '  feat-alpha');
    assert.equal(rows[6], '  fix-beta');
    assert.equal(rows[7], DEFAULT_LINE, 'the focused worktree\'s data line follows the list');
    assert.equal(rows[8], '↑↓ move · enter choose · c create · ctrl+d delete · r reload · esc close', 'one legend row, with no `v all` while nothing is hidden, the delete key, and no retired edit key');
    assert.match(lines[9], /^╰─+╯$/, 'the frame is closed');
    assert.equal(lines.length, 10, 'the frame fills its computed height exactly');
  });

  test('the frame is exactly as tall as its content, never taller than the rows offered', async () => {
    for (const rows of [8, 9, 10, 12, 20, 40]) {
      for (const width of [40, WIDTH, 120]) {
        const { view } = await opened({ rows });
        const frame = panel(view, width);
        const expected = Math.min(7 + 3, rows);
        assert.equal(frame.height, expected, `rows ${rows}/${width}: the frame fits its content`);
        assertWidth(frame.lines, width);
        assert.match(frame.title, /^╭─ Warp /, `rows ${rows}/${width}: the title line survives`);
        assert.match(frame.bottom, /^╰─+╯$/, `rows ${rows}/${width}: the frame stays closed`);
        assert.equal(frame.separator, '', `rows ${rows}/${width}: the separator never moves`);
      }
    }
  });

  test('shows at most five worktree rows, with the offer row only when one is left out', async () => {
    const many = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const { view } = await opened({ checkouts: many, current: { name: 'cur', path: '/w/cur' }, rows: HEIGHT });
    const frame = panel(view);
    assert.equal(frame.worktrees.length, 5, 'S4b: at most five worktree rows');
    assert.equal(frame.viewAll, '  view all worktrees', 'S4c: the offer row closes the list');
    assert.equal(frame.height, 7 + 5 + 1, 'the offer row is part of the computed height');
    assert.equal(frame.height, frame.lines.length, 'the frame fills that height exactly');
    const body = frame.rows.join('\n');
    assert.ok(!body.includes('wt-6'), 'the sixth worktree is beyond the bound');
    assert.ok(!body.includes('wt-8'));
    assert.ok(frame.focusData.length > 0, 'the focused row keeps its data line');
  });

  test('the offer row is absent when every worktree fits, and at its five-row boundary', async () => {
    const five = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 5 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const fits = panel((await opened({ checkouts: five, current: { name: 'cur', path: '/w/cur' } })).view);
    assert.equal(fits.worktrees.length, 5);
    assert.equal(fits.viewAll, null, 'S4c: everything fits, so neither the row nor its key appears');
    assert.ok(!fits.rows.join('\n').includes('view all'), 'the offer is nowhere on screen');
    assert.equal(fits.height, 7 + 5);

    const six = [...five, { name: 'wt-6', path: '/w/wt-6', branch: 'feat/wt-6' }];
    const hidden = panel((await opened({ checkouts: six, current: { name: 'cur', path: '/w/cur' } })).view);
    assert.equal(hidden.worktrees.length, 5, 'the sixth row is what makes the offer appear');
    assert.equal(hidden.viewAll, '  view all worktrees');
    assert.equal(hidden.height, 7 + 5 + 1);

    const few = panel((await opened({ checkouts: CHECKOUTS, current: { name: CURRENT.name, path: CURRENT.path } })).view);
    assert.equal(few.viewAll, null, 'three other worktrees need no offer row');
  });

  test('the current worktree owns the header and is never one of the rows', async () => {
    const { view } = await opened();
    const frame = panel(view, WIDE);
    assert.equal(frame.currentName, 'feat-odd-viewer');
    assert.ok(!frame.worktrees.some((row) => row.includes('feat-odd-viewer')), 'S4b: the current is not listed again');
    assert.equal(frame.lines.filter((line) => line.includes('feat-odd-viewer')).length, 1, 'it appears exactly once');
  });

  test('an empty list names its state and keeps creation on the hotkey', async () => {
    const { view, results } = await opened({ checkouts: [CURRENT], current: { name: CURRENT.name, path: CURRENT.path } });
    const frame = panel(view);
    assert.deepEqual(frame.list, ['(no other worktrees)'], 'the list area explains itself');
    assert.equal(frame.focusData, '', 'there is no focused worktree to describe');
    assert.equal(frame.height, 8, 'the panel shrinks to its content');
    view.handleInput('enter');
    view.handleInput('e');
    assert.deepEqual(results, [], 'enter and e are inert with nothing to focus');
    view.handleInput('c');
    assert.deepEqual(results, [{ create: true }], 'S6: c opens the create flow');
  });

  test('a terminal too small for the panel says so in one line', async () => {
    const { view } = await opened({ rows: 4 });
    const lines = view.render(WIDTH).map(strip);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Warp .* enlarge the terminal/);
    assertWidth(lines);
  });
});

describe('current worktree data line (S4a)', () => {
  const CURRENT_FACTS = {
    branch: 'feat/odd-viewer', changes: { added: 0, deleted: 0 }, ahead: 0, behind: 2, createdAt: ago(2 * 86400_000), lastActivity: ago(3600_000),
  };

  test('the line under the current name reports that worktree\'s own facts', async () => {
    const { view } = await opened({
      facts: (path) => (path === CURRENT.path ? CURRENT_FACTS : { ...CURRENT_FACTS, branch: 'main' }),
    });
    const frame = panel(view, WIDE);
    assert.equal(frame.currentData, 'branch feat/odd-viewer · ↓2 · created 2d ago · modified 1h ago');
    assert.ok(frame.focusData.startsWith('branch main'), 'the focused line keeps its own worktree');
  });

  test('an unreadable current worktree says unavailable instead of a zero', async () => {
    const { view } = await opened({ facts: (path) => (path === CURRENT.path ? null : CURRENT_FACTS) });
    const frame = panel(view, WIDE);
    assert.equal(
      frame.currentData,
      `branch unavailable · changes unavailable · ↑unavailable ↓unavailable · ${NO_AGES}`,
    );
    assert.ok(!frame.currentData.includes(' 0'), 'a failed read never claims a number');
  });
});

describe('focused checkout facts (S4d, S9)', () => {
  const BASE = { branch: 'main', changes: { added: 12, deleted: 3 }, ahead: 1, behind: 2, createdAt: '2026-01-05T00:00:00.000Z', lastActivity: '2026-02-28T00:00:00.000Z' };
  const FULL = 'branch main · +12 −3 · ↑1 ↓2 · created 1mo ago · modified 1d ago';

  test('the focused checkout reports branch, the change-size line counts, ahead/behind and created-at', async () => {
    const { view } = await opened({ facts: () => BASE });
    const frame = panel(view, WIDE);
    assert.equal(frame.worktrees[0], '▸ main · use the local project', 'the principal is focused first');
    assert.equal(frame.focusData, FULL, 'the focused data line carries every fact');
  });

  test('every fact that cannot be read renders unavailable, never zero', async () => {
    const { view } = await opened({ facts: () => null });
    const frame = panel(view, WIDE);
    assert.equal(frame.focusData, `branch unavailable · changes unavailable · ↑unavailable ↓unavailable · ${NO_AGES}`);
  });

  test('S1: a legacy association in the facts is never rendered, not even as a count', async () => {
    const { view } = await opened({ facts: () => ({ ...BASE, issues: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], assignedOdd: 'odd/tasks/w9-x.md', odd: ['w9-x', 'w9-y'] }) });
    const frame = panel(view, WIDE);
    assert.equal(frame.focusData, FULL, `the line carries no association: ${frame.focusData}`);
    for (const word of ['issues', 'w9-x', 'w9-y', '#1', '#10']) {
      assert.ok(!frame.lines.join('\n').includes(word), `no association reaches the frame (${word})`);
    }
  });

  test('each single unavailable fact is reported on its own while the others survive', async () => {
    const cases = [
      ['branch', 'branch unavailable'],
      ['changes', 'changes unavailable'],
      ['ahead', '↑unavailable'],
      ['behind', '↓unavailable'],
      ['createdAt', 'created —'],
      ['lastActivity', 'modified —'],
    ];
    for (const [field, expected] of cases) {
      const facts = { ...BASE, [field]: field === 'createdAt' ? 'unavailable' : null };
      const { view } = await opened({ facts: () => facts });
      const line = panel(view, WIDE).focusData;
      assert.ok(line.includes(expected), `${field} renders "${expected}": ${line}`);
      assert.ok(!/↑0|↓0|\+0 −0/.test(line), `a missing number is never 0: ${line}`);
    }
  });

  test('a measured zero is omitted for the change size and both arrows', async () => {
    const { view } = await opened({ facts: () => ({ ...BASE, changes: { added: 0, deleted: 0 }, ahead: 0, behind: 0, issues: [], odd: [] }) });
    assert.equal(panel(view, WIDE).focusData, 'branch main · created 1mo ago · modified 1d ago');
  });

  test('a one-sided ahead shows only ↑N, and a one-sided behind only ↓M', async () => {
    const aheadOnly = await opened({ facts: () => ({ ...BASE, behind: 0 }) });
    assert.equal(panel(aheadOnly.view, WIDE).focusData, 'branch main · +12 −3 · ↑1 · created 1mo ago · modified 1d ago');
    const behindOnly = await opened({ facts: () => ({ ...BASE, ahead: 0 }) });
    assert.equal(panel(behindOnly.view, WIDE).focusData, 'branch main · +12 −3 · ↓2 · created 1mo ago · modified 1d ago');
  });

  test('the change size is the tracked and untracked LINE counts, never a file count', async () => {
    const { view } = await opened({ facts: () => ({ ...BASE, changes: { added: 4, deleted: 1 } }) });
    const line = panel(view, WIDE).focusData;
    assert.ok(line.includes('+4 −1'), `the line counts render: ${line}`);
    assert.ok(!line.includes('changes +'), `the sign already says what the number is: ${line}`);
    assert.ok(!/files|uncommitted/.test(line), `no file count survives: ${line}`);
  });

  test('the change size drops its label, and keeps it only where the counts cannot be read', async () => {
    // S16 (feedback): `+A −D` already says what the number is, so the word
    // before it was noise. An UNREADABLE size still needs the label, or
    // `unavailable` would not say which fact is missing.
    const known = await opened({ facts: () => ({ ...BASE, changes: { added: 7, deleted: 2 } }) });
    const knownLine = panel(known.view, WIDE).focusData;
    assert.ok(knownLine.includes('· +7 −2 ·'), `the bare counts render: ${knownLine}`);
    assert.ok(!/changes \+/.test(knownLine), `no label before readable counts: ${knownLine}`);

    const unknown = await opened({ facts: () => ({ ...BASE, changes: null }) });
    assert.ok(panel(unknown.view, WIDE).focusData.includes('· changes unavailable ·'), 'unknown keeps an intelligible label');

    const fileCountOnly = await opened({ facts: () => ({ ...BASE, changes: { files: 3 } }) });
    const fileCountLine = panel(fileCountOnly.view, WIDE).focusData;
    assert.ok(fileCountLine.includes('changes unavailable'), `a bare file count is not a size: ${fileCountLine}`);
    assert.ok(!/\+\d/.test(fileCountLine), 'and it never becomes a made-up count');
  });

  test('an unavailable value still renders where its zero would have been omitted', async () => {
    const { view } = await opened({ facts: () => ({ ...BASE, changes: null, ahead: null, behind: null }) });
    const line = panel(view, WIDE).focusData;
    assert.ok(line.includes('changes unavailable'), `the change size stays visible: ${line}`);
    assert.ok(line.includes('↑unavailable ↓unavailable'), `both arrows stay visible: ${line}`);
  });

  test('moving the selection refreshes the data line and reads each checkout only once', async () => {
    const facts = (path) => ({ ...BASE, branch: path === '/w/feat-alpha' ? 'feat/alpha' : 'main' });
    const { view, factCalls, paints } = await opened({ facts });
    assert.deepEqual(factCalls, ['/w/feat-odd-viewer', '/w/herdr'], 'the current and the focused checkout are read');
    assert.ok(paints.length > 0, 'the component repaints after a move');
    view.handleInput('down');
    screen(view, WIDE);
    await tick();
    const moved = panel(view, WIDE);
    assert.deepEqual(factCalls, ['/w/feat-odd-viewer', '/w/herdr', '/w/feat-alpha'], 'the new focus is read on demand');
    assert.ok(moved.focusData.startsWith('branch feat/alpha'), `the data follows the focus: ${moved.focusData}`);
    view.handleInput('up');
    screen(view, WIDE);
    view.handleInput('down');
    screen(view, WIDE);
    assert.equal(factCalls.length, 3, 'cached facts are never re-read');
  });

  test('a slow facts read never blocks a frame and cannot be shown as zero', async () => {
    const { view } = makeView({ facts: () => new Promise(() => {}) });
    const frame = panel(view, WIDE);
    assert.equal(frame.height, 10, 'the frame renders while both reads are in flight');
    assertWidth(frame.lines, WIDE);
    assert.match(frame.focusData, /reading/, 'the pending read says so');
    assert.match(frame.currentData, /reading/, 'the current worktree says so too');
    assert.ok(!/↑0|↓0/.test(frame.focusData));
  });

  test('a failing facts read degrades to unavailable instead of throwing', async () => {
    const { view } = await opened({ facts: () => Promise.reject(new Error('git failed')) });
    const frame = panel(view, WIDE);
    assert.ok(frame.focusData.includes('branch unavailable'), frame.focusData);
    assert.ok(!frame.focusData.includes('0'), 'a failed read never claims a number');
  });
});

describe('ordering and both ages (S12)', () => {
  const ORDERED = [
    { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
    { name: 'stale', path: '/w/stale', branch: 'feat/stale', lastActivity: ago(10 * 86400_000) },
    { name: 'open', path: '/w/open', branch: 'feat/open', lastActivity: null, lastActivityReason: 'not a git repository' },
    { name: 'commit-fresh', path: '/w/commit-fresh', branch: 'feat/cf', lastActivity: ago(60_000) },
    { name: 'dirty-fresh', path: '/w/dirty-fresh', branch: 'feat/df', lastActivity: ago(3600_000) },
  ];

  test('orders the rows by last activity descending, keeps the unreadable one last and never prints its reason', async () => {
    const { view } = await opened({ checkouts: ORDERED, current: { name: 'cur', path: '/w/cur' }, facts: () => null });
    const rows = panel(view, WIDE).worktrees;
    assert.match(rows[0], /^▸ commit-fresh/, 'the most recent commit leads and takes the focus');
    assert.match(rows[1], /^ {2}dirty-fresh/, 'a recent dirty file follows the commit');
    assert.match(rows[2], /^ {2}stale/);
    assert.match(rows[3], /^ {2}open/, 'the unreadable row sorts last');
    for (let i = 0; i < 4; i += 1) view.handleInput('down');
    screen(view, WIDE);
    await tick();
    const focused = panel(view, WIDE);
    assert.match(focused.worktrees[3], /^▸ open/);
    assert.ok(focused.focusData.endsWith('modified —'), `a brief value replaces a fake date: ${focused.focusData}`);
    assert.ok(!focused.focusData.includes('not a git repository'), `the reason stays out of the row: ${focused.focusData}`);
    assert.ok(!/modified 20\d\d/.test(focused.focusData));
    const stored = view.state.checkouts.find((entry) => entry.path === '/w/open');
    assert.equal(stored.lastActivityReason, 'not a git repository', 'the provenance is kept in data');
  });

  test('the extended list keeps the same order', async () => {
    const { view } = await opened({ checkouts: ORDERED, current: { name: 'cur', path: '/w/cur' }, facts: () => null });
    view.handleInput('v');
    const { rows } = screen(view, WIDE);
    assert.match(rows[2], /commit-fresh/);
    assert.match(rows[3], /dirty-fresh/);
    assert.match(rows[4], /stale/);
    assert.match(rows[5], /open/);
    assert.equal(rows[6], '', 'the current checkout is not a row, so `open` is the last one');
  });

  test('renders both ages in the package style, from just now to years', () => {
    const line = (facts) => formatFactsLine(facts, { now: NOW });
    // The suffix matches lib/issues-view.js, so one clock never reads two ways
    // across the package's surfaces.
    assert.ok(line({ createdAt: ago(30_000), lastActivity: ago(30_000) }).endsWith('created just now · modified just now'));
    assert.ok(line({ createdAt: ago(60_000), lastActivity: ago(2 * 60_000) }).endsWith('created 1m ago · modified 2m ago'));
    assert.ok(line({ createdAt: ago(3600_000), lastActivity: ago(2 * 3600_000) }).endsWith('created 1h ago · modified 2h ago'));
    assert.ok(line({ createdAt: ago(86400_000), lastActivity: ago(2 * 86400_000) }).endsWith('created 1d ago · modified 2d ago'));
    assert.ok(line({ createdAt: ago(30 * 86400_000), lastActivity: ago(60 * 86400_000) }).endsWith('created 1mo ago · modified 2mo ago'));
    assert.ok(line({ createdAt: ago(365 * 86400_000), lastActivity: ago(2 * 365 * 86400_000) }).endsWith('created 1y ago · modified 2y ago'));
    assert.ok(line({ createdAt: null, lastActivity: null }).endsWith(NO_AGES));
  });
});

// S15: "las preview son breves, no puedes poner ese texto entenso para ese
// caso de modified". The screenshot showed `modified no activity since the
// checkout was created`; a compact row now carries the brief value only, and
// the provenance the caller supplied stays available in the component's data.
describe('S15: compact facts rows never print the raw reason', () => {
  const LONG = 'no activity since the checkout was created';
  const WITH_REASON = { ...DEFAULT_FACTS, lastActivity: null, lastActivityReason: LONG };

  test('an unreadable age renders a dash instead of the long explanation', async () => {
    const { view } = await opened({ facts: () => WITH_REASON });
    const frame = panel(view, WIDE);
    assert.ok(frame.focusData.endsWith('created 28d ago · modified —'), `the readable age survives and the other stays brief: ${frame.focusData}`);
    assert.ok(!frame.focusData.includes(LONG), `no prose reason in the row: ${frame.focusData}`);
    assert.ok(!frame.currentData.includes(LONG), `nor under the current worktree: ${frame.currentData}`);
    assert.ok(!frame.lines.join('\n').includes('activity since'), 'the reason appears nowhere on screen');
  });

  test('a row-level reason is kept as data and never rendered', async () => {
    const checkouts = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      { name: 'stale', path: '/w/stale', branch: 'feat/stale', lastActivity: null, lastActivityReason: LONG },
    ];
    const { view } = await opened({ checkouts, current: { name: 'cur', path: '/w/cur' }, facts: () => null });
    const frame = panel(view, WIDE);
    assert.match(frame.worktrees[0], /^▸ stale/, 'the unreadable row still sorts last and takes the focus');
    assert.ok(frame.focusData.endsWith('modified —'), `the row's own reason is not printed: ${frame.focusData}`);
    const stored = view.state.checkouts.find((entry) => entry.path === '/w/stale');
    assert.equal(stored.lastActivityReason, LONG, 'the provenance survives in the component data');
  });

  test('the created age uses the same brief form, and a real timestamp is never replaced', async () => {
    const line = (facts) => formatFactsLine(facts, { now: NOW });
    assert.ok(line({ createdAt: { available: false, reason: 'birthtime unavailable on this filesystem' }, lastActivity: { available: false, reason: LONG } }).endsWith(NO_AGES));
    assert.ok(line({ createdAt: '2026-02-01', lastActivity: ago(2 * 86400_000) }).endsWith('created 28d ago · modified 2d ago'), 'readable values never lose their age');
  });
});

describe('the create key and the retired edit key (S1, S4, S6)', () => {
  test('c opens the create flow and no list row offers creation', async () => {
    const { view, results } = await opened();
    const frame = panel(view, WIDE);
    assert.ok(!frame.rows.join('\n').includes('create a worktree'), 'S6: creation is not a row any more');
    assert.match(frame.legend, /c create/, 'the legend names the hotkey');
    view.handleInput('c');
    assert.deepEqual(results, [{ create: true }]);
  });

  test('c stays ordinary text in the extended list, where the filter owns printables', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    view.handleInput('c');
    assert.equal(view.state.filter, 'c', 'the filter took the character');
    assert.deepEqual(results, []);
  });

  test('S4: `e` is not a binding any more — no edit request, no legend token, nothing edited', async () => {
    const { view, results } = await opened();
    const frame = panel(view, WIDE);
    assert.ok(!frame.legend.includes('e edit'), `the legend names no edit key: ${frame.legend}`);
    for (const width of [40, 80, 120]) {
      assert.ok(!panel(view, width).legend.includes('e edit'), `width ${width}: no edit token at any width`);
    }
    view.handleInput('e');
    assert.deepEqual(results, [], 'e resolves nothing on a focused checkout row');

    const empty = await opened({ checkouts: [CURRENT], current: { name: CURRENT.name, path: CURRENT.path } });
    empty.view.handleInput('e');
    assert.deepEqual(empty.results, [], 'e on an empty list is inert');

    const many = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const offered = await opened({ checkouts: many, current: { name: 'cur', path: '/w/cur' } });
    for (let i = 0; i < 5; i += 1) offered.view.handleInput('down');
    assert.match(panel(offered.view).viewAll || '', /^▸ view all worktrees$/, 'the offer row is focused');
    offered.view.handleInput('e');
    assert.deepEqual(offered.results, [], 'e on the offer row is inert too');

    const listed = await opened();
    listed.view.handleInput('v');
    listed.view.handleInput('T');
    listed.view.handleInput('e');
    assert.equal(listed.view.state.filter, 'e', 'e is typed text while the filter is open');
    assert.deepEqual(listed.results, []);
  });
});

describe('extended list (S1, S6)', () => {
  test('v opens a paginated list of every other checkout with an always-active filter row', async () => {
    const { view } = await opened();
    view.handleInput('v');
    assert.equal(view.state.view, 'list');
    const { lines, rows } = screen(view);
    assert.equal(lines.length, HEIGHT);
    assertWidth(lines);
    assert.match(lines[0], /^╭─ Warp · all worktrees ─+ esc ─╮$/);
    assert.equal(rows[1], 'filter: type to search', 'the filter row is always present and never selectable');
    assert.equal(rows[2], '▸ main · use the local project', 'S6: the principal leads the list');
    assert.equal(rows[3], '  feat-alpha');
    assert.equal(rows[4], '  fix-beta');
    assert.equal(rows[5], '', 'the checkout the session stands in is not a destination');
    assert.equal(rows[17], 'page 1/1 · 3 worktrees');
    assert.match(rows[18], /enter warp/);
    assert.match(rows[18], /esc back/);
    assert.ok(!rows.slice(2, 17).join('\n').includes('current: '), 'the filter row is not a data row');
  });

  test('typing filters the list live and the filter row is not a selectable item', async () => {
    const { view } = await opened();
    view.handleInput('v');
    view.handleInput('a');
    assert.equal(view.state.filterOpen, true);
    assert.equal(view.state.filter, 'a');
    let { rows } = screen(view);
    assert.equal(rows[1], 'filter: a▏', 'the typed text lands in the filter row');
    for (const ch of 'lpha') view.handleInput(ch);
    ({ rows } = screen(view));
    assert.equal(rows[1], 'filter: alpha▏');
    assert.equal(rows[2], '▸ feat-alpha');
    assert.equal(rows[3], '');
    const body = rows.join('\n');
    assert.ok(!body.includes('fix-beta'), 'non-matching rows are filtered out');
    assert.equal(rows[17], 'page 1/1 · 1 worktree');
    assert.equal(view.state.listCursor, 0, 'the cursor tracks the filtered rows');
  });

  test('the filter excludes rows that match nothing and enter cannot warp from it', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    for (const ch of 'zzz') view.handleInput(ch);
    const { lines, rows } = screen(view);
    assertWidth(lines);
    assert.equal(rows[1], 'filter: zzz▏');
    assert.equal(rows[2], '(no matches for "zzz")');
    assert.equal(rows[17], 'page 1/1 · 0 worktrees');
    view.handleInput('enter');
    assert.deepEqual(results, [], 'enter on an empty result warps nowhere');
  });

  test('pgUp/pgDn page through every other checkout', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` }));
    const { view } = await opened({ checkouts: many, current: { name: 'wt-1', path: '/w/wt-1' }, rows: 11 });
    view.handleInput('v');
    let { rows } = screen(view);
    // 11 rows - 5 fixed rows = a 6-row page, and wt-1 (the session's own
    // checkout) is not one of the eleven destinations.
    assert.equal(rows[2], '▸ wt-2');
    assert.equal(rows[7], '  wt-7');
    assert.equal(rows[8], 'page 1/2 · 11 worktrees', 'the page row sits right below the six rows');
    view.handleInput('pagedown');
    ({ rows } = screen(view));
    assert.equal(view.state.page, 1);
    assert.equal(rows[2], '▸ wt-8');
    assert.equal(rows[6], '  wt-12');
    assert.equal(rows[7], '', 'the second page holds the remaining five rows');
    assert.equal(rows[8], 'page 2/2 · 11 worktrees');
    view.handleInput('pagedown');
    assert.equal(view.state.page, 1, 'the last page is a wall');
    view.handleInput('pageup');
    ({ rows } = screen(view));
    assert.equal(view.state.page, 0);
    assert.equal(rows[2], '▸ wt-2');
  });

  test('esc closes the filter first and then steps back to the panel', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    view.handleInput('a');
    assert.equal(view.state.filterOpen, true);
    view.handleInput('escape');
    assert.equal(view.state.filterOpen, false, 'esc closes the filter, keeping the query');
    assert.equal(view.state.view, 'list', 'and stays in the list');
    assert.equal(view.state.filter, 'a');
    view.handleInput('escape');
    assert.equal(view.state.view, 'popup', 'esc steps back exactly one level');
    assert.deepEqual(results, [], 'stepping back never resolves the component');
    view.handleInput('escape');
    assert.deepEqual(results, [null], 'esc from the panel closes the component');
  });

  test('ctrl+c steps back from the list too', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    view.handleInput('ctrl+c');
    assert.equal(view.state.view, 'popup');
    assert.deepEqual(results, []);
  });

  test('enter on a checkout warps to its path', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(results, [{ warp: '/w/feat-alpha' }], 'the second row is feat-alpha: the current checkout is not listed');
  });
});

describe('the S6 space rule', () => {
  test('space toggles while the filter is closed, types once it is open, and toggles again after it closes', async () => {
    const { view, toggles } = await opened({ onToggle: () => {} });
    view.handleInput('v');
    view.handleInput('down');
    assert.equal(view.state.listCursor, 1);

    view.handleInput(' ');
    assert.deepEqual(toggles, ['/w/feat-alpha'], 'space toggles the focused row while the filter is closed');
    assert.equal(view.state.filterOpen, false, 'and never opens the filter');
    assert.equal(view.state.filter, '');

    view.handleInput('z');
    assert.equal(view.state.filterOpen, true, 'a printable that is not a binding opens the filter');
    assert.equal(view.state.filter, 'z');
    view.handleInput(' ');
    assert.equal(view.state.filter, 'z ', 'once open, space goes to the text');
    assert.deepEqual(toggles, ['/w/feat-alpha'], 'and no longer toggles');

    view.handleInput('escape');
    assert.equal(view.state.filterOpen, false);
    assert.equal(view.state.view, 'list');
    view.handleInput('T');
    assert.equal(view.state.filterOpen, true, 'T opens the filter explicitly');
    assert.equal(view.state.filter, '', 'and starts an empty query');
    view.handleInput('escape');
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(toggles, ['/w/feat-alpha', '/w/feat-alpha'], 'closing an empty filter restores the toggle');
  });

  test('without a toggle, space is a printable and opens the filter', async () => {
    const { view } = await opened();
    view.handleInput('v');
    view.handleInput(' ');
    assert.equal(view.state.filterOpen, true);
    assert.equal(view.state.filter, ' ');
  });
});

describe('S9: no redundant help overlay', () => {
  test('? is unbound in both views and never replaces the rows', async () => {
    const { view } = await opened();
    const before = JSON.parse(JSON.stringify(view.state));
    view.handleInput('?');
    assert.ok(panel(view).worktrees.some((text) => /feat-alpha/.test(text)), 'the panel rows stay');
    assert.deepEqual(view.state, before, '? changes no state in the panel');

    view.handleInput('v');
    view.handleInput('?');
    const { rows } = screen(view);
    assert.equal(view.state.filter, '?', '? is ordinary printable text in the list, never a help toggle');
    assert.match(rows[1], /filter: \?/);
    assert.match(rows[2], /no matches for/);
  });

  test('the legends name every shortcut and never advertise ? help', async () => {
    const { view } = await opened();
    assert.equal(panel(view, WIDE).legend, '↑↓ move · enter choose · c create · ctrl+d delete · r reload · esc close');
    assert.ok(!panel(view, WIDE).legend.includes('?'), 'no generic help hint in the panel legend');

    // S4c: the offer row and its key appear together, only when a worktree
    // is left out.
    const many = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const offered = await opened({ checkouts: many, current: { name: 'cur', path: '/w/cur' } });
    assert.match(panel(offered.view, WIDE).legend, /v all/, 'the offer key rides with the offer row');

    view.handleInput('v');
    const { rows } = screen(view);
    assert.equal(rows[18], '↑↓ move · pgUp/pgDn page · enter warp · ctrl+d delete · r reload · esc back');
    assert.ok(!rows[18].includes('?'), 'no generic help hint in the list legend');
  });
});

describe('S6: the principal leads when it is not the current checkout', () => {
  test('a principal with the oldest activity still renders before newer checkouts', async () => {
    const checkouts = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      { name: 'recent', path: '/w/recent', branch: 'feat/recent', lastActivity: ago(60_000) },
      { name: 'main', path: '/w/herdr', branch: 'main', isPrincipal: true, lastActivity: ago(90 * 86400_000) },
      { name: 'older', path: '/w/older', branch: 'feat/older', lastActivity: ago(120 * 86400_000) },
    ];
    const { view } = await opened({ checkouts, current: { name: 'cur', path: '/w/cur' }, facts: () => null });
    const rows = panel(view, WIDE).worktrees;
    assert.equal(rows[0], '▸ main · use the local project', 'the principal is first despite the oldest activity');
    assert.equal(rows[1], '  recent');
    assert.equal(rows[2], '  older');
  });
});

describe('S1: render performs no I/O and enrichment keeps the selection', () => {
  test('the mount reads the current and the focused checkout; render() adds no read', async () => {
    let calls = 0;
    const { view } = makeView({ facts: () => { calls += 1; return DEFAULT_FACTS; } });
    assert.equal(calls, 2, 'the mount reads the current worktree and the first focused row');
    screen(view);
    screen(view, 120);
    assert.equal(calls, 2, 'render() reads nothing');
    view.handleInput('down');
    assert.equal(calls, 3, 'moving the focus starts the one read');
  });

  test('apply() re-sorts by the newly arrived activity and keeps the focused checkout', async () => {
    const initial = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      { name: 'alpha', path: '/w/alpha', branch: 'feat/alpha' },
      { name: 'beta', path: '/w/beta', branch: 'feat/beta' },
    ];
    const { view } = await opened({ checkouts: initial, current: { name: 'cur', path: '/w/cur' }, facts: () => null });
    view.handleInput('down');
    view.handleInput('down'); // focus beta (the second list row, clamped)
    assert.equal(view.state.cursor, 1);
    view.apply([
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      { name: 'alpha', path: '/w/alpha', branch: 'feat/alpha', lastActivity: '2026-02-01T00:00:00.000Z' },
      { name: 'beta', path: '/w/beta', branch: 'feat/beta', lastActivity: '2026-02-02T00:00:00.000Z' },
    ]);
    const rows = panel(view, WIDE).worktrees;
    assert.equal(rows[0], '▸ beta', 'beta now leads by activity and holds the focus');
    assert.equal(rows[1], '  alpha');
  });

  test('apply() after escape is ignored while a delayed facts answer settles, and never throws', async () => {
    let releaseFacts;
    const delayed = new Promise((resolve) => { releaseFacts = resolve; });
    const { view, results } = makeView({ facts: () => delayed });
    await tick();
    view.handleInput('down'); // start the focused checkout's pending read
    view.handleInput('escape'); // the panel resolves: the component is settled
    assert.deepEqual(results, [null]);
    const before = JSON.parse(JSON.stringify(view.state.checkouts));

    const replacement = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      { name: 'late', path: '/w/late', branch: 'feat/late', lastActivity: '2026-02-02T00:00:00.000Z' },
    ];
    assert.doesNotThrow(() => view.apply(replacement));
    releaseFacts(DEFAULT_FACTS);
    await tick();
    await tick();
    assert.deepEqual(view.state.checkouts, before, 'a settled view ignores late enrichment');
  });
});

// S12/S4: Delete clears the WHOLE query only while the search field is
// active, Backspace still removes one character, and neither of them ever
// signals anything else — S4 removed the worktree deletion binding entirely.
describe('S12: Delete clears the search, Backspace edits it', () => {
  const filterRow = (view, width = WIDTH) => screen(view, width).rows[1];

  test('Delete empties the whole query while the search is active', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    for (const char of 'alpha') view.handleInput(char);
    assert.equal(view.state.filter, 'alpha');
    view.handleInput('\x1b[3~'); // the raw Delete sequence
    assert.equal(view.state.filter, '', 'one Delete clears everything typed');
    assert.equal(view.state.filterOpen, true, 'the search stays active');
    assert.equal(view.state.listCursor, 0, 'the cursor starts over on the full list');
    assert.equal(filterRow(view), 'filter: ▏', 'the empty query is back in the field');
    assert.ok(!screen(view).rows.slice(2, 17).join('\n').includes('no matches'), 'every row is visible again');
    assert.deepEqual(results, [], 'clearing a search never resolves a deletion');
  });

  test('the installed matcher spelling of Delete clears it too', async () => {
    const { view } = await opened();
    view.handleInput('v');
    for (const char of 'beta') view.handleInput(char);
    view.handleInput('delete');
    assert.equal(view.state.filter, '');
  });

  test('Backspace still deletes exactly one character', async () => {
    const { view } = await opened();
    view.handleInput('v');
    for (const char of 'alpha') view.handleInput(char);
    view.handleInput('backspace');
    assert.equal(view.state.filter, 'alph');
    view.handleInput('\x7f');
    assert.equal(view.state.filter, 'alp');
  });

  test('Delete with the search closed changes nothing', async () => {
    const { view, results } = await opened();
    view.handleInput('down');
    assert.match(panel(view).worktrees[1], /^▸ feat-alpha$/, 'a row is focused');
    const before = JSON.parse(JSON.stringify(view.state));
    view.handleInput('\x1b[3~');
    assert.deepEqual(results, [], 'Delete is not a binding');
    assert.deepEqual(view.state, before, 'and it changes no state');
  });

  test('the footer advertises Delete clear on one row only while the search is active', async () => {
    for (const width of [40, 80, 120]) {
      const { view } = await opened();
      view.handleInput('v');
      view.handleInput('T');
      const open = view.render(width).map(strip);
      const openLegend = open[open.length - 2];
      assert.match(openLegend, /clear/, `width ${width}: the active search names the clear key: ${openLegend}`);
      assert.equal(open.filter((line) => /clear/.test(line)).length, 1, `width ${width}: hints stay on the one footer row`);
      assert.ok(!openLegend.includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${openLegend}`);
      view.handleInput('\x1b'); // close the search, keeping the query
      const closed = view.render(width).map(strip);
      assert.ok(!/clear/.test(closed[closed.length - 2]), `width ${width}: no clear hint when no search is active`);
      assert.equal(closed.length, HEIGHT, `width ${width}: the legend takes no extra row`);
    }
  });
});

describe('keys that are not in the map', () => {
  test('no key outside the documented map changes the panel state', async () => {
    const { view, results } = await opened();
    screen(view, WIDE);
    const before = JSON.parse(JSON.stringify(view.state));
    for (const key of ['x', 'q', 'tab', 'home', 'end', 'left', 'right', 'ctrl+s', 'backspace']) {
      view.handleInput(key);
    }
    assert.deepEqual(view.state, before);
    assert.deepEqual(results, [], 'and none of them resolves the component');
  });

  test('no key outside the documented map changes the list state', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    screen(view);
    const before = { listCursor: view.state.listCursor, filter: view.state.filter, filterOpen: view.state.filterOpen, view: view.state.view, help: view.state.help };
    for (const key of ['tab', 'home', 'end', 'left', 'right', 'ctrl+s']) view.handleInput(key);
    assert.deepEqual({ listCursor: view.state.listCursor, filter: view.state.filter, filterOpen: view.state.filterOpen, view: view.state.view, help: view.state.help }, before);
    assert.deepEqual(results, []);
  });
});

describe('selection and reload', () => {
  test('j/k move the selection and clamp at both ends', async () => {
    const { view } = await opened();
    view.handleInput('j');
    assert.equal(view.state.cursor, 1);
    view.handleInput('k');
    assert.equal(view.state.cursor, 0);
    view.handleInput('k');
    assert.equal(view.state.cursor, 0, 'the first row is a clamp');
    for (let i = 0; i < 10; i += 1) view.handleInput('down');
    assert.equal(view.state.cursor, 2, 'clamped on the third checkout row');
  });

  test('c resolves create and esc resolves null exactly once', async () => {
    const create = await opened();
    create.view.handleInput('c');
    assert.deepEqual(create.results, [{ create: true }]);

    const closed = await opened();
    closed.view.handleInput('escape');
    closed.view.handleInput('escape');
    assert.deepEqual(closed.results, [null], 'the component resolves once');
  });

  test('enter on the offer row opens the extended list instead of resolving', async () => {
    const many = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const { view, results } = await opened({ checkouts: many, current: { name: 'cur', path: '/w/cur' }, rows: 14 });
    for (let i = 0; i < 5; i += 1) view.handleInput('down');
    assert.match(panel(view).viewAll || '', /^▸ view all worktrees$/, 'the offer row is focused');
    view.handleInput('enter');
    assert.equal(view.state.view, 'list');
    assert.deepEqual(results, []);
  });

  test('r reloads through the injected callback and re-reads both data lines', async () => {
    const reloaded = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      { name: 'new-shape', path: '/w/new-shape', branch: 'feat/new-shape' },
    ];
    const { view, reloadCalls, factCalls } = await opened({
      checkouts: [
        { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
        { name: 'old-shape', path: '/w/old-shape', branch: 'feat/old-shape' },
      ],
      current: { name: 'cur', path: '/w/cur' },
      reloadTo: reloaded,
    });
    assert.deepEqual(factCalls, ['/w/cur', '/w/old-shape'], 'the mount reads the current and the focused row once');
    view.handleInput('r');
    assert.equal(reloadCalls.length, 1, 'the reload reader is the only source');
    await tick();
    const rows = panel(view).worktrees;
    assert.match(rows[0], /new-shape/);
    assert.deepEqual(
      factCalls,
      ['/w/cur', '/w/old-shape', '/w/cur', '/w/new-shape'],
      'the cached facts are dropped on reload and both data lines are re-read',
    );
  });
});

// S2: a key legend is ONE terminal row. A legend that does not fit the frame
// is compacted (short tokens, then the lowest-priority keys dropped), so it
// is never ellipsis-clipped and never spills onto a second row.
describe('S2: one-row key legends', () => {
  const WIDTHS = [40, 60, 80, 120];

  function legendRows(lines, marker) {
    return lines.map(strip).filter((line) => marker.test(line));
  }

  test('the panel legend owns exactly one row at every width', async () => {
    for (const width of WIDTHS) {
      const { view } = await opened();
      const frame = panel(view, width);
      assert.equal(frame.height, 10, `width ${width}: the content height is unchanged`);
      const legend = legendRows(frame.lines, /esc close|↑↓/);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /↑↓/, `width ${width}: the movement keys survive`);
      assert.match(legend[0], /esc close/, `width ${width}: the close key survives`);
      assert.equal(helpers.visibleWidth(frame.lines[frame.lines.length - 2]), width, `width ${width}: the legend row is cell-exact`);
    }
  });

  test('the extended-list legend owns exactly one row at every width', async () => {
    for (const width of WIDTHS) {
      const { view } = await opened();
      view.handleInput('v');
      const { lines } = screen(view, width);
      assert.equal(lines.length, HEIGHT, `width ${width}: the list still fills its rows`);
      const legend = legendRows(lines, /esc back|↑↓/);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /↑↓/, `width ${width}: the movement keys survive`);
      assert.match(legend[0], /esc back/, `width ${width}: the back key survives`);
      assert.equal(helpers.visibleWidth(lines[18]), width, `width ${width}: the legend row is cell-exact`);
    }
  });
});

// S4: the panel and the extended list both ask to DELETE the focused
// checkout with `ctrl+d`. The component only names the request — the
// extension owns the confirmation, the evidence and every refusal — so what
// is pinned here is that the exact focused path travels in the marker, that
// nothing else resolves (the offer row, an empty list), and that both
// legends advertise the key while the search footer keeps its own meaning
// for `delete`.
describe('S4: ctrl+d asks to delete the focused checkout', () => {
  test('ctrl+d on a checkout row resolves the delete request for that exact path', async () => {
    for (const spelling of ['\x04', 'ctrl+d']) {
      const { view, results } = await opened();
      view.handleInput('down');
      assert.match(panel(view).worktrees[1], /^▸ feat-alpha$/, 'a checkout row is focused');
      view.handleInput(spelling);
      assert.deepEqual(results, [{ delete: '/w/feat-alpha' }], `${JSON.stringify(spelling)} names the focused path`);
    }
  });

  test('ctrl+d on the offer row and on an empty panel resolves nothing', async () => {
    const many = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const offered = await opened({ checkouts: many, current: { name: 'cur', path: '/w/cur' } });
    for (let i = 0; i < 5; i += 1) offered.view.handleInput('down');
    assert.match(panel(offered.view).viewAll || '', /^▸ view all worktrees$/, 'the offer row is focused');
    offered.view.handleInput('ctrl+d');
    assert.deepEqual(offered.results, [], 'the offer row is not a checkout to delete');

    const empty = await opened({ checkouts: [CURRENT], current: { name: CURRENT.name, path: CURRENT.path } });
    empty.view.handleInput('ctrl+d');
    assert.deepEqual(empty.results, [], 'an empty panel has nothing to delete');
  });

  test('ctrl+d in the extended list names the focused row and stays inert while the filter is open', async () => {
    const { view, results } = await opened();
    view.handleInput('v');
    // The list is every OTHER checkout, principal first: main, then feat-alpha
    // — so the focused row after one move is feat-alpha.
    view.handleInput('down');
    view.handleInput('\x04');
    assert.deepEqual(results, [{ delete: '/w/feat-alpha' }], 'the list speaks the same marker');

    const searching = await opened();
    searching.view.handleInput('v');
    searching.view.handleInput('T');
    const before = { listCursor: searching.view.state.listCursor, filter: searching.view.state.filter, view: searching.view.state.view };
    searching.view.handleInput('ctrl+d');
    assert.deepEqual(searching.results, [], 'while typing, ctrl+d deletes nothing');
    assert.deepEqual({ listCursor: searching.view.state.listCursor, filter: searching.view.state.filter, view: searching.view.state.view }, before);
  });

  test('both legends advertise the delete key at every width it fits', async () => {
    for (const width of [80, 120]) {
      const { view } = await opened();
      assert.match(panel(view, width).legend, /ctrl\+d delete/, `width ${width}: the panel names it`);
      view.handleInput('v');
      const { lines } = screen(view, width);
      assert.match(lines[lines.length - 2], /ctrl\+d delete/, `width ${width}: and so does the extended list`);
    }
  });

  test('the panel legend is the same at every width and every focus', async () => {
    for (const width of [40, 60, 80, 120]) {
      const { view } = await opened();
      const first = panel(view, width).legend;
      view.handleInput('down');
      assert.equal(panel(view, width).legend, first, `width ${width}: moving the focus adds no capability token`);
      assert.equal(helpers.visibleWidth(panel(view, width).lines[8]), width, `width ${width}: the legend row is cell-exact`);
    }
  });
});

// ---------------------------------------------------------------------------
// S1: worktrees no longer receive issues or ODD. The stored registry data is
// preserved (the facts payload still carries it), and no association — id,
// name, path or count — may reach the panel's line.
// ---------------------------------------------------------------------------
describe('S1: no issue or ODD association is rendered', () => {
  const line = (facts) => formatFactsLine(facts, { now: NOW });
  const BASE = { branch: 'feat/x', changes: { added: 1, deleted: 0 }, ahead: 1, behind: 0, createdAt: '2026-02-01' };

  test('the rendered line carries no association, even when the facts do', () => {
    const facts = line({ ...BASE, issues: [76, 77], assignedOdd: 'odd/tasks/alpha.md', odd: ['alpha', 'beta'] });
    assert.equal(facts, 'branch feat/x · +1 −0 · ↑1 · created 28d ago · modified —');
    for (const word of ['issues', 'odd', 'alpha', 'beta', '#76']) {
      assert.ok(!facts.includes(word), `no association in the line (${word}): ${facts}`);
    }
  });

  test('an empty or unreadable association is simply absent, never `-` or `unavailable`', () => {
    const empty = line({ ...BASE, issues: [], odd: [] });
    const unreadable = line({ ...BASE, issues: null, odd: 'unavailable' });
    assert.equal(empty, unreadable, 'both read as "no association" because the line has no such fact');
    assert.ok(!empty.includes('-') || empty.includes('modified —'), `no association placeholder: ${empty}`);
    assert.ok(!/issues: unavailable|odd: unavailable/.test(unreadable), unreadable);
  });

  test('the panel and the extended list never print an association', async () => {
    const { view } = await opened({ facts: () => LEGACY_FACTS });
    const frame = panel(view, WIDE);
    assert.equal(frame.focusData, DEFAULT_LINE, 'the focused line is association-free');
    assert.equal(frame.currentData, DEFAULT_LINE, 'so is the current worktree line');
    view.handleInput('v');
    const listed = screen(view, WIDE).lines.join('\n');
    assert.ok(!listed.includes('issues'), 'the extended list names no issue association');
    assert.ok(!/w1-a|w2-b|#12/.test(listed), 'and no ODD document or issue id either');
  });
});

// ---------------------------------------------------------------------------
// S11/T9: every footer and header token paints through the ONE shared palette
// (lib/tui-paint.js) with the injected theme — a shortcut KEY (a button) is
// accent+bold, its description muted, a TITLE takes the reference UI's `dim`
// title role (its Agents title: ~/.config/herdr-app/mods/agents/main.js:413),
// ordinary values are the text role and counts/labels are muted
// or dim — while the focus cue stays monochrome (`▸`), so a theme that answers
// nothing still reads as a frame.
describe('S11: the shared palette', () => {
  test('the panel legend paints every key accent+bold and its description muted', async () => {
    const theme = recordingTheme();
    const { view } = await opened({ theme });
    const legend = view.render(WIDE).at(-2);
    assert.match(legend, /\x1b\[1m\x1b\[96m↑↓\x1b\[0m\x1b\[22m\x1b\[90m move/, 'the movement key is accent+bold, its description muted');
    assert.match(legend, /\x1b\[1m\x1b\[96menter\x1b\[0m\x1b\[22m\x1b\[90m choose/, 'the confirm key keeps its own role');
    assert.match(legend, /\x1b\[1m\x1b\[96mesc\x1b\[0m\x1b\[22m\x1b\[90m close/, 'so does esc, with its words muted');
    assert.match(legend, /\x1b\[34m · \x1b\[0m/, 'the entries are joined by the border role');
    assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === '↑↓'),
      'the accent role is requested from the injected theme');
    assert.ok(theme.calls.some((call) => call.role === 'bold' && call.text.includes('↑↓')),
      'the key is bolded through the theme, never by a literal escape');
    assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text === ' move'),
      'the description asks the injected theme for the muted role');
  });

  test('the extended list and the active-search legend use the same key/description palette', async () => {
    const theme = recordingTheme();
    const { view } = await opened({ theme });
    view.handleInput('v');
    const browse = view.render(WIDE).at(-2);
    assert.match(browse, /\x1b\[1m\x1b\[96mpgUp\/pgDn\x1b\[0m\x1b\[22m\x1b\[90m page/, 'a compound key is ONE key run');
    assert.match(browse, /\x1b\[1m\x1b\[96menter\x1b\[0m\x1b\[22m\x1b\[90m warp/, 'and its description is muted');
    assert.match(browse, /\x1b\[1m\x1b\[96mesc\x1b\[0m\x1b\[22m\x1b\[90m back/, 'the back key is a key');
    view.handleInput('T');
    const search = view.render(WIDE).at(-2);
    assert.match(search, /\x1b\[1m\x1b\[96mbackspace\x1b\[0m\x1b\[22m\x1b\[90m del char/, 'the search legend paints its keys too');
    assert.match(search, /\x1b\[1m\x1b\[96mdelete\x1b\[0m\x1b\[22m\x1b\[90m clear/, 'delete keeps the key role');
    assert.match(search, /\x1b\[1m\x1b\[96mesc\x1b\[0m\x1b\[22m\x1b\[90m keep filter/, 'so does esc keep filter');
  });

  test('a compacted legend keeps the key roles instead of falling back to plain descriptions', async () => {
    const theme = recordingTheme();
    const { view } = await opened({ theme });
    const legend = view.render(40).at(-2);
    assert.match(legend, /\x1b\[1m\x1b\[96m↑↓\x1b\[0m\x1b\[22m/, 'the compact form still paints the movement key');
    assert.match(legend, /\x1b\[1m\x1b\[96mesc\x1b\[0m\x1b\[22m\x1b\[90m close/, 'esc keeps its key and its description');
    assert.equal(helpers.visibleWidth(legend), 40, 'the compacted row is still cell-exact');
  });

  test('the header palette: secondary title+bold, values ordinary text, facts muted and the close key a button', async () => {
    const theme = recordingTheme();
    const { view } = await opened({ theme });
    const lines = view.render(WIDE);
    assert.match(lines[0], /\x1b\[1m\x1b\[33mWarp\x1b\[0m\x1b\[22m/,
      'the frame title is the Agents view title role, bold');
    assert.ok(!theme.calls.some((call) => call.role === 'accent' && call.text === 'Warp'),
      'the title never takes the button accent');
    assert.match(lines[0], /\x1b\[1m\x1b\[96mesc\x1b\[0m\x1b\[22m/, 'the close hint in the header is painted as a key');
    assert.match(lines[0], /\x1b\[34m╭─\x1b\[0m/, 'the frame rule keeps the border role');
    assert.match(lines[1], /\x1b\[39mfeat-odd-viewer/, 'the current worktree name is ordinary text');
    assert.ok(!/\x1b\[1m\x1b\[96mfeat-odd-viewer/.test(lines[1]), 'a value is never emphasized like a key');
    assert.ok(!/\x1b\[96mfeat-odd-viewer/.test(lines[1]), 'a value is never the button accent');
    assert.match(lines[2], /\x1b\[90mbranch feat\/alpha/, 'the facts line is muted');
    assert.match(lines.at(-3), /\x1b\[90mbranch feat\/alpha/, 'so is the focused worktree line');
  });

  test('the list page row paints its label dim, the page value as ordinary text and the total muted', async () => {
    const theme = recordingTheme();
    const { view } = await opened({ theme, rows: 20 });
    view.handleInput('v');
    const pageRow = view.render(WIDE).at(-3);
    assert.match(pageRow, /\x1b\[2mpage \x1b\[0m/, 'the `page` label is dim');
    assert.match(pageRow, /\x1b\[39m1\/1\x1b\[0m/, 'the page number is ordinary text');
    assert.match(pageRow, /\x1b\[90m · 3 worktrees\x1b\[0m/, 'the worktree count is muted');
  });

  test('the search row paints its static label dim and the live query as ordinary text', async () => {
    const theme = recordingTheme();
    const { view } = await opened({ theme });
    view.handleInput('v');
    const idle = view.render(WIDE)[1];
    assert.match(idle, /\x1b\[2mfilter: \x1b\[0m\x1b\[90mtype to search/, 'the idle hint is dim/muted, never accent');
    view.handleInput('a');
    view.handleInput('l');
    const live = view.render(WIDE)[1];
    assert.match(live, /\x1b\[2mfilter: \x1b\[0m/, 'the label stays dim while typing');
    assert.match(live, /\x1b\[39mal/, 'the typed query is ordinary text');
    assert.ok(!/\x1b\[96mal/.test(live), 'the typed query is never the button accent');
  });

  test('a hostile theme never breaks the frame and keeps the keys and the focus mark readable', async () => {
    const hostile = {
      fg() { throw new Error('no colour support'); },
      bold() { throw new Error('no bold support'); },
      bg() { throw new Error('no background support'); },
    };
    const { view } = await opened({ theme: hostile });
    const { lines, rows } = screen(view, WIDE);
    assert.match(lines[0], /^╭─ Warp ─+ esc ─╮$/, 'the title line still renders without colour');
    assert.match(rows[rows.length - 2], /↑↓ move · enter choose · c create · ctrl\+d delete · r reload · esc close/,
      'the legend still spells every key and its words');
    assert.equal(rows[4], '▸ main · use the local project', 'the focus marker survives monochrome');
    view.handleInput('v');
    assert.match(screen(view, WIDE).rows.at(-2), /pgUp\/pgDn page/, 'the list legend survives too');
  });
});

// ---------------------------------------------------------------------------
// Feedback: warping to the checkout the session already stands in is a move to
// the same route, so `view all worktrees` never offers it. The exclusion is by
// CHECKOUT IDENTITY, never by spelling or by string prefix: the fixtures below
// are real directories with a real symlink alias, and the canonical reader the
// wiring hands the view (fs.realpathSync) is what makes two spellings one
// checkout, while `feat-x2` stays its own checkout even though it starts with
// `feat-x`.
// ---------------------------------------------------------------------------
describe('the current checkout is never a destination', () => {
  const realpath = (value) => {
    try { return fs.realpathSync(value); } catch { return value; }
  };

  // A real temporary workspace: real checkout directories, real symlinks, and
  // every scratch path removed when the test ends.
  function workspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-view-'));
    t.after(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    });
    return {
      dir,
      checkout(name) {
        const full = path.join(dir, name);
        fs.mkdirSync(full);
        return full;
      },
      alias(name, target) {
        const full = path.join(dir, name);
        fs.symlinkSync(target, full);
        return full;
      },
    };
  }

  test('the extended list drops the checkout the session is in and keeps the others', async (t) => {
    const ws = workspace(t);
    const principal = ws.checkout('herdr');
    const feat = ws.checkout('feat-alpha');
    const fix = ws.checkout('fix-beta');
    const { view } = await opened({
      checkouts: [
        { name: 'feat-alpha', path: feat, branch: 'feat/alpha' },
        { name: 'principal', path: principal, branch: 'main', isPrincipal: true },
        { name: 'fix-beta', path: fix, branch: 'fix/beta' },
      ],
      current: { name: 'feat-alpha', path: feat },
      canonicalPath: realpath,
    });
    view.handleInput('v');
    const { lines, rows } = screen(view);
    assertWidth(lines);
    assert.equal(rows[2], '▸ principal · use the local project', 'the principal still leads the destinations');
    assert.equal(rows[3], '  fix-beta');
    assert.equal(rows[4], '', 'and nothing else follows');
    assert.ok(!rows.join('\n').includes('feat-alpha'), 'the checkout the session is in is not a destination');
    assert.equal(rows[17], 'page 1/1 · 2 worktrees');
  });

  test('a symlink spelling of the current checkout is the same checkout, in both directions', async (t) => {
    const ws = workspace(t);
    const feat = ws.checkout('feat-alpha');
    const alias = ws.alias('alias-alpha', feat);
    const principal = ws.checkout('herdr');

    const listedByAlias = await opened({
      checkouts: [
        { name: 'principal', path: principal, branch: 'main', isPrincipal: true },
        { name: 'alias-alpha', path: alias, branch: 'feat/alpha' },
      ],
      current: { name: 'feat-alpha', path: feat },
      canonicalPath: realpath,
    });
    listedByAlias.view.handleInput('v');
    assert.ok(!screen(listedByAlias.view).rows.join('\n').includes('alias-alpha'),
      'the alias of the current checkout is not a destination');
    assert.equal(screen(listedByAlias.view).rows[17], 'page 1/1 · 1 worktree');

    const listedByReal = await opened({
      checkouts: [
        { name: 'principal', path: principal, branch: 'main', isPrincipal: true },
        { name: 'feat-alpha', path: feat, branch: 'feat/alpha' },
      ],
      current: { name: 'alias-alpha', path: alias },
      canonicalPath: realpath,
    });
    listedByReal.view.handleInput('v');
    assert.ok(!screen(listedByReal.view).rows.join('\n').includes('feat-alpha'),
      'the real path is the same checkout as the alias the session stands on');
    assert.equal(screen(listedByReal.view).rows[17], 'page 1/1 · 1 worktree');
  });

  test('a checkout whose name merely starts with the current path is another checkout', async (t) => {
    const ws = workspace(t);
    const feat = ws.checkout('feat-x');
    const featTwo = ws.checkout('feat-x2');
    const { view } = await opened({
      checkouts: [
        { name: 'feat-x', path: feat, branch: 'feat/x' },
        { name: 'feat-x2', path: featTwo, branch: 'feat/x2' },
      ],
      current: { name: 'feat-x', path: feat },
      canonicalPath: realpath,
    });
    view.handleInput('v');
    const { rows } = screen(view);
    assert.equal(rows[2], '▸ feat-x2', 'a shared name prefix is not the same checkout');
    assert.equal(rows[3], '', 'and the current checkout itself is still absent');
    assert.equal(rows[17], 'page 1/1 · 1 worktree');
  });

  test('the panel and the list share one exclusion, so neither lists the current checkout', async (t) => {
    const ws = workspace(t);
    const feat = ws.checkout('feat-alpha');
    const alias = ws.alias('alias-alpha', feat);
    const principal = ws.checkout('herdr');
    const { view } = await opened({
      checkouts: [
        { name: 'principal', path: principal, branch: 'main', isPrincipal: true },
        { name: 'alias-alpha', path: alias, branch: 'feat/alpha' },
      ],
      current: { name: 'feat-alpha', path: feat },
      canonicalPath: realpath,
    });
    const frame = panel(view, WIDE);
    assert.deepEqual(frame.worktrees, ['▸ principal · use the local project'], 'the panel lists only the other checkout');
    assert.equal(frame.viewAll, null, 'nothing is left out, so there is no offer row');
    assert.equal(frame.height, 8, 'the panel shrinks to its content');
  });

  test('with nothing else to list, the extended list says so and resolves nothing', async (t) => {
    const ws = workspace(t);
    const feat = ws.checkout('feat-alpha');
    const { view, results } = await opened({
      checkouts: [{ name: 'feat-alpha', path: feat, branch: 'feat/alpha' }],
      current: { name: 'feat-alpha', path: feat },
      canonicalPath: realpath,
    });
    view.handleInput('v');
    const { lines, rows } = screen(view);
    assertWidth(lines);
    assert.equal(rows[2], '(no other worktrees)', 'the list explains itself instead of naming the current checkout');
    assert.equal(rows[17], 'page 1/1 · 0 worktrees');
    view.handleInput('enter');
    view.handleInput('ctrl+d');
    assert.deepEqual(results, [], 'an empty destination list warps nowhere and deletes nothing');
  });

  test('a session standing outside every listed checkout keeps every row', async (t) => {
    const ws = workspace(t);
    const principal = ws.checkout('herdr');
    const feat = ws.checkout('feat-alpha');
    const { view } = await opened({
      checkouts: [
        { name: 'principal', path: principal, branch: 'main', isPrincipal: true },
        { name: 'feat-alpha', path: feat, branch: 'feat/alpha' },
      ],
      current: { name: 'unknown', path: path.join(ws.dir, 'nowhere') },
      canonicalPath: realpath,
    });
    view.handleInput('v');
    const { rows } = screen(view);
    assert.equal(rows[2], '▸ principal · use the local project');
    assert.equal(rows[3], '  feat-alpha');
    assert.equal(rows[17], 'page 1/1 · 2 worktrees', 'a current checkout outside the list excludes nothing');
  });

  test('a reload that re-lists the current checkout under another spelling still excludes it', async (t) => {
    const ws = workspace(t);
    const feat = ws.checkout('feat-alpha');
    const alias = ws.alias('alias-alpha', feat);
    const principal = ws.checkout('herdr');
    const { view } = await opened({
      checkouts: [
        { name: 'principal', path: principal, branch: 'main', isPrincipal: true },
        { name: 'feat-alpha', path: feat, branch: 'feat/alpha' },
      ],
      current: { name: 'feat-alpha', path: feat },
      canonicalPath: realpath,
      reloadTo: [
        { name: 'principal', path: principal, branch: 'main', isPrincipal: true },
        { name: 'alias-alpha', path: alias, branch: 'feat/alpha' },
      ],
    });
    view.handleInput('v');
    assert.ok(!screen(view).rows.join('\n').includes('alias-alpha'), 'the mount already excludes it');
    view.handleInput('r');
    await tick();
    assert.ok(!screen(view).rows.join('\n').includes('alias-alpha'), 'the reloaded spelling is the same checkout');
    assert.equal(screen(view).rows[17], 'page 1/1 · 1 worktree');
  });
});

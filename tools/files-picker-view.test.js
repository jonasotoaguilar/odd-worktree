'use strict';
// T6 (files-picker S1-S6, S14, S15): `lib/files-picker-view.js` — the `/files`
// panel, as a composition of T1's listing, T4's rows and T5's preview.
//
// Contract under test, as observable output only: the card frame, the `›` search
// row, the two panes and their widths, the rows and their badges/ages/tones, the
// footer's one option per key with the active order, the keys of S4, the mouse
// routes of S5, and the four ways the panel settles (insert, editor, close, and
// the listing that never arrives). The listing and the preview are injected, so
// the whole suite runs without a repository, a theme or a highlighter.
//
// T9 adds the round L9 rules to the same surface: the info row with the counts
// and the order at the list's edge (S22), the folder order named `tree` (S23), the
// full-height preview geometry with the rule under the body (S25) and the Tab mark
// bar in a theme role (S26). Its "a cursor only rests on file rows" rule (S24) is
// superseded by S38's every-row cursor, and the tree round's "shift+space folds the
// other groups" (S34) by S39's one toggle over every group. Whatever a rule change
// retargeted says so where it is asserted.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createFilesPickerView } = require('../lib/files-picker-view.js');

// Optional real dependency: the host's pi-tui package, which owns the ONE matcher
// this view's keys are written against. CI installs no dependencies, so resolve it
// once here and SKIP only the test that genuinely needs it; every other case runs
// through the fake helpers above or the view's own spelled fallback.
let TUI_AVAILABLE = false;
try {
  require.resolve('@earendil-works/pi-tui');
  TUI_AVAILABLE = true;
} catch {
  TUI_AVAILABLE = false;
}
if (!TUI_AVAILABLE) {
  console.error(
    'files-picker-view: SKIPPING the real-matcher shift+space test (no @earendil-works/pi-tui found)',
  );
}

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const WIDTH = 120;
// The terminal rows the view is offered; the card takes its share of them (S15).
const ROWS_AVAILABLE = 20;
const CARD_HEIGHT = 17;
// 0-based row of the first body row: the top rule, the search row, the info row.
const BODY_TOP = 3;
// S25: the row the blank separator row used to be is the INFO row — the counts,
// the fill and the order — and the preview's box top border rides it. A
// full-width rule then closes the body under both columns on its own row, so the
// chrome is the top rule, the search row, the info row, that rule, the footer and
// the bottom rule: six rows, and the body keeps CARD_HEIGHT - 6.
const INFO_ROW = 2;
const SEARCH_ROW = 1;
const BODY_ROWS = CARD_HEIGHT - 6;
const RULE_ROW = BODY_TOP + BODY_ROWS;
const CURSOR_MARK = '\u25b8';
const SELECTION_MARK = '\u258f';
const LIST_MAX_WIDTH = 64;

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// ANSI-aware stand-ins for the host TUI helpers, injected exactly as the view
// takes them: nothing here is imported statically.
const helpers = {
  visibleWidth: (text) => [...strip(text)].length,
  truncateToWidth: (text, width, ellipsis = '\u2026') => {
    const chars = [...String(text)];
    return chars.length > width
      ? `${chars.slice(0, Math.max(0, width - 1)).join('')}${ellipsis}`
      : String(text);
  },
  wrapTextWithAnsi: (text, width) => {
    const chars = [...String(text)];
    const rows = [];
    for (let at = 0; at < chars.length; at += Math.max(1, width)) {
      rows.push(chars.slice(at, at + Math.max(1, width)).join(''));
    }
    return rows.length > 0 ? rows : [''];
  },
  matchesKey: (data, name) => data === name,
  isKeyRelease: (data) => data === 'release',
};

const plainTheme = {
  fg: (_role, text) => String(text),
  bold: (text) => String(text),
  bg: (_role, text) => String(text),
};

// A theme that records which role painted each string and paints every role with
// its own SGR code, so a rendered line can be read for the ROLE behind a token.
const ROLE_SGR = { accent: 96, customMessageLabel: 33, muted: 90, dim: 2, border: 34, text: 39, error: 91 };

function recordingTheme() {
  const calls = [];
  const code = (role) => ROLE_SGR[role] ?? 95;
  return {
    calls,
    fg(role, text) {
      calls.push({ role, text: String(text) });
      return `\x1b[${code(role)}m${text}\x1b[0m`;
    },
    bold(text) {
      calls.push({ role: 'bold', text: String(text) });
      return `\x1b[1m${text}\x1b[22m`;
    },
    bg(role, text) {
      calls.push({ role: `bg:${role}`, text: String(text) });
      return `\x1b[48;5;${code(role)}m${text}\x1b[0m`;
    },
  };
}

const SCOPE = { root: '/home/dev/repo-worktrees/files-picker', kind: 'worktree', label: 'files-picker' };

// The listing T1 answers: changed first and newest first, then clean by path.
const FILES = [
  { path: 'brand-new.ts', state: 'new', mtimeMs: NOW - 5_000, age: '5s' },
  { path: 'src/cursor.ts', state: 'updated', mtimeMs: NOW - 2 * HOUR, age: '2h' },
  { path: 'README.md', state: 'clean' },
  { path: 'src/lib/util.ts', state: 'clean' },
];

// A listing with two top-level folders, one nested folder and a root file, so the
// S30/S39 fold rules have something to open and something to leave closed.
const NESTED = [
  { path: 'src/web/test.ts', state: 'clean' },
  { path: 'src/index.ts', state: 'clean' },
  { path: 'web/app.ts', state: 'clean' },
  { path: 'README.md', state: 'clean' },
];

function preview(lines, truncated = false) {
  return { kind: 'text', lines, truncated };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(options = {}) {
  const calls = { insert: [], open: [], close: 0, render: 0 };
  let renders = 0;
  const view = createFilesPickerView({
    theme: options.theme === undefined ? plainTheme : options.theme,
    helpers: options.helpers === undefined ? helpers : options.helpers,
    rowsAvailable: options.rowsAvailable === undefined ? ROWS_AVAILABLE : options.rowsAvailable,
    scope: options.scope === undefined ? SCOPE : options.scope,
    cwd: '/home/dev/repo/files-picker',
    loadEntries: options.loadEntries === undefined
      ? async () => ({ ok: true, entries: options.entries === undefined ? FILES : options.entries })
      : options.loadEntries,
    loadPreview: options.loadPreview === undefined
      ? async (path) => preview([`preview of ${path}`, 'second line'])
      : options.loadPreview,
    highlight: options.highlight,
    languageForPath: options.languageForPath,
    now: options.now === undefined ? NOW : options.now,
    onInsert: (paths) => {
      calls.insert.push(paths);
      if (typeof options.onInsert === 'function') options.onInsert(paths);
    },
    onOpen: (path) => {
      calls.open.push(path);
      if (typeof options.onOpen === 'function') options.onOpen(path);
    },
    onClose: () => {
      calls.close += 1;
      if (typeof options.onClose === 'function') options.onClose();
    },
    requestRender: () => {
      renders += 1;
      calls.render = renders;
      if (typeof options.requestRender === 'function') options.requestRender();
    },
  });
  return { view, calls, renderCount: () => renders };
}

// A mounted panel that already paints its listing and its first preview.
async function open(options = {}) {
  const mounted = mount(options);
  const width = options.width === undefined ? WIDTH : options.width;
  mounted.view.render(width);
  await tick();
  mounted.view.render(width);
  await tick();
  mounted.view.render(width);
  return mounted;
}

function rowsOf(view, width = WIDTH) {
  return view.render(width).map(strip);
}

function rowOf(rows, text) {
  const index = rows.findIndex((row) => row.includes(text));
  assert.ok(index >= 0, `missing ${JSON.stringify(text)} in the frame:\n${rows.join('\n')}`);
  return index;
}

// The left pane cell of the row painting `text`, without the card border.
function listCell(rows, text) {
  return (rows[rowOf(rows, text)].split(' │ ')[0] || '').replace(/^│ /, '');
}

function footerOf(rows) {
  return rows[rows.length - 2].replace(/^│ /, '').replace(/ +│$/, '');
}

function bodyText(rows) {
  return rows.slice(BODY_TOP, rows.length - 2).join('\n');
}

// Every body row's list cell, trailing blanks trimmed: the marker column, the
// indent and the label, as the reader sees them (S29's chevrons read from here).
function bodyCells(rows, width = WIDTH) {
  return rows.slice(BODY_TOP, RULE_ROW).map((row) => listLine(row, width).trimEnd());
}

// The group rows only: the cursor mark or a blank, then the chevron (S29).
function groupCells(rows, width = WIDTH) {
  return bodyCells(rows, width).filter((cell) => /^[\u25b8 ][\u25be\u25b8] /.test(cell));
}

function selectedRow(rows) {
  // The cursor mark owns the FIRST cell of the marker column; a collapsed group's
  // chevron paints the second one, so the glyph alone no longer identifies the
  // focused row (S29).
  const line = rows.find((row) => row.slice(2).startsWith(CURSOR_MARK));
  assert.ok(line, 'a selected row must be painted');
  return line;
}

// The list pane's painted width, measured from the frame a click is routed through.
function listWidth(rows) {
  return rows[BODY_TOP].indexOf(' │ ') - 2;
}

function previewStart(rows) {
  return rows[BODY_TOP].indexOf(' │ ') + 3;
}

// The two pane widths the card computes for one width (S15, S25), read here so a
// cell can be sliced even on a row that carries no painted pane rule.
function paneWidths(width = WIDTH) {
  const inner = width - 4;
  const list = Math.max(1, Math.min(LIST_MAX_WIDTH, Math.floor(inner * 0.45)));
  return { inner, list, preview: Math.max(0, inner - list - 3) };
}

// The list column's cell of one row, without the card border.
function listLine(row, width = WIDTH) {
  return [...row].slice(2, 2 + paneWidths(width).list).join('');
}

// The preview pane's cell of the row the box top rides (S25).
function previewTop(rows) {
  const start = previewStart(rows);
  return [...rows[INFO_ROW]].slice(start, [...rows[INFO_ROW]].length - 2).join('');
}

// The list pane's cell of the info row: the counts, the fill and the order (S22).
function infoCell(rows, width = WIDTH) {
  return listLine(rows[INFO_ROW], width);
}

// The selected row's list cell, without the three-cell marker column.
function selectedLabel(rows, width = WIDTH) {
  return listLine(selectedRow(rows), width).slice(3).trim();
}

// The selected row's first label token: a file name, or a group row's name.
function selectedName(rows, width = WIDTH) {
  return selectedLabel(rows, width).split(/\s+/)[0];
}

// The SGR sequence in force at the FIRST `glyph` of a painted row, or '' when the
// cell is unstyled: a theme role always leaves one behind (S26).
function sgrAt(line, glyph) {
  const at = line.indexOf(glyph);
  if (at < 0) return '';
  const found = [...line.slice(0, at).matchAll(/\x1b\[[0-9;]*m/g)];
  return found.length === 0 ? '' : found[found.length - 1][0];
}

function previewPane(rows, offset) {
  const row = [...rows[BODY_TOP + offset]];
  const start = previewStart(rows);
  return row.slice(start, row.length - 2).join('');
}

// A mouse event local to the last painted card.
function mouse(overrides = {}) {
  return {
    type: 'click',
    button: 'left',
    x: 3,
    y: BODY_TOP,
    width: WIDTH,
    height: CARD_HEIGHT,
    ...overrides,
  };
}

describe('the card chrome (S1, S15)', () => {
  test('the frame is exact at two widths, with Files at the left and esc at the right', async () => {
    const { view } = await open({ scope: undefined });
    for (const width of [120, 80]) {
      const rows = rowsOf(view, width);
      assert.equal(rows.length, CARD_HEIGHT);
      for (const row of rows) assert.equal(helpers.visibleWidth(row), width, `no row is ragged at ${width}`);
      assert.ok(rows[0].startsWith('╭─ ✿ Files'), rows[0]);
      assert.ok(rows[0].endsWith('esc ╮'), rows[0]);
      assert.ok(rows[rows.length - 1].startsWith('╰─'));
      assert.ok(rows[rows.length - 1].endsWith('╯'));
    }
  });

  test('the listing path rides the title at the left, and esc keeps the far corner alone (S37)', async () => {
    const { view } = await open();
    // The whole row, as painted: the panel's name, ` · `, the path, the filling
    // rule, and `esc` alone at the right corner. The 63-column fill is
    // 120 - 47 (title + path) - 5 (chrome) - 5 (the ` esc ` cell).
    assert.equal(
      rowsOf(view)[0],
      `╭─ ✿ Files · ${SCOPE.root} ${'─'.repeat(63)} esc ╮`,
      'the path rides the panel title, never the right corner',
    );
    // The path is nowhere near the corner: what follows it is only the rule and the
    // `esc` cell.
    const afterPath = rowsOf(view)[0].slice(3 + `✿ Files · ${SCOPE.root}`.length);
    assert.match(afterPath, /^ ─+ esc ╮$/, `only the rule and esc follow the path: ${JSON.stringify(afterPath)}`);
  });

  test('a narrow card elides the path from its left, so the tail that identifies the checkout survives (S37)', async () => {
    const { view } = await open();
    // 50 columns: the title keeps 30 for the path (50 - 7 for `✿ Files` - 3 for
    // ` · ` - 5 for the chrome - 5 for ` esc `), which keeps the last 29 characters.
    assert.equal(
      view.render(50).map(strip)[0],
      '╭─ ✿ Files · …v/repo-worktrees/files-picker  esc ╮',
    );
    // 40 columns leaves 20 for the path: the tail still names the checkout.
    assert.equal(
      view.render(40).map(strip)[0],
      '╭─ ✿ Files · …ktrees/files-picker  esc ╮',
    );
    for (const width of [50, 40]) {
      const row = view.render(width).map(strip)[0];
      assert.equal(helpers.visibleWidth(row), width);
      assert.ok(row.startsWith('╭─ ✿ Files · …'), `the path still follows the title at ${width}: ${row}`);
      assert.ok(!row.includes('/home'), 'the head of the path gives way, never its tail');
      assert.ok(row.includes(SCOPE.root.slice(-10)), `the identifying tail survives at ${width}: ${row}`);
      assert.ok(row.endsWith('esc ╮'), 'esc keeps the far right corner');
    }
  });

  test('the card uses the rows it is offered, grows with them and never exceeds them', async () => {
    let previous = 0;
    for (const rowsAvailable of [20, 40, 60]) {
      const { view } = await open({ rowsAvailable });
      const rows = rowsOf(view);
      for (const row of rows) assert.equal(helpers.visibleWidth(row), WIDTH);
      assert.ok(rows.length > previous, `the card grows with ${rowsAvailable} rows`);
      assert.ok(rows.length <= rowsAvailable, `the card never exceeds the ${rowsAvailable} rows`);
      const painted = footerOf(rows);
      assert.ok(painted.includes('esc') && painted.includes('enter'), `the footer is painted: ${painted}`);
      previous = rows.length;
    }
    assert.equal(mount({ rowsAvailable: () => 40 }).view.render(WIDTH).length, 34);
    assert.deepEqual(mount({ rowsAvailable: () => { throw new Error('no rows'); } }).view.render(WIDTH), []);
    const absent = createFilesPickerView({ loadEntries: async () => ({ ok: true, entries: [] }) });
    assert.deepEqual(absent.render(WIDTH), []);
    assert.deepEqual(absent.render(0), []);
  });

  test('a terminal too narrow or too short paints one fitted line', async () => {
    const { view } = await open({ rowsAvailable: 12 });
    const narrow = view.render(10).map(strip);
    assert.equal(narrow.length, 1);
    assert.equal(helpers.visibleWidth(narrow[0]), 10);
    assert.ok(narrow[0].startsWith('Files'));
    assert.equal(mount({ rowsAvailable: 5 }).view.render(WIDTH).length, 1);
  });

  test('the smallest card keeps the frame, the search row and the footer, and drops the path first', async () => {
    const { view } = await open({ rowsAvailable: 8 });
    for (const width of [20, 24]) {
      const rows = rowsOf(view, width);
      assert.equal(rows.length, 6, 'the smallest card still paints every chrome row');
      for (const row of rows) assert.equal(helpers.visibleWidth(row), width, `no row is ragged at ${width}`);
      assert.ok(rows[0].startsWith('╭─ ✿ Files'), rows[0]);
      assert.ok(rows[0].endsWith('esc ╮'), 'too narrow a card drops the path, never the title or esc');
      assert.ok(rows[SEARCH_ROW].startsWith('│ › '), `the search row keeps its prompt: ${rows[SEARCH_ROW]}`);
      // The rule changed with S25: the search row is now the list pane's width, so
      // the narrowest card elides the placeholder word instead of the query row
      // crossing the whole card.
      assert.ok(infoCell(rows).includes('/'), `the smallest card still counts its files: ${infoCell(rows)}`);
      assert.ok(footerOf(rows).includes('esc'), `the smallest card still names esc: ${footerOf(rows)}`);
    }
  });

  test('the search row sits under the title, narrowed to the list pane (S25)', async () => {
    const { view } = await open();
    const rows = rowsOf(view);
    assert.ok(rows[SEARCH_ROW].startsWith('│ › Search'), rows[SEARCH_ROW]);
    assert.ok(rows[SEARCH_ROW].endsWith('│'));
    // The search row is the list pane's width; the preview column beside it is
    // blank, and the info row sits directly under it in the list column.
    assert.equal((rows[SEARCH_ROW].match(/│/g) || []).length, 2, 'no pane rule crosses the search row');
    assert.equal(rows[SEARCH_ROW].slice(2 + listWidth(rows), -2).trim(), '', 'the search row never spills into the preview');
    assert.match(infoCell(rows), /^4\/4 \(0\) ─+ files$/, 'the info row sits under the search row');
    assert.ok(rows[BODY_TOP].includes('brand-new.ts'), 'the list starts under the info row');
  });

  test('the search row never paints past the list pane, however long the query', async () => {
    const { view } = await open();
    const long = 'a-very-long-query-that-cannot-fit-in-the-list-pane';
    for (const character of long) view.handleInput(character);
    // At 40 columns the list pane is 16 cells: the query is elided there, never
    // painted over the preview's column.
    const narrow = rowsOf(view, 40);
    assert.ok(narrow[SEARCH_ROW].includes('a-very-long'), narrow[SEARCH_ROW]);
    assert.ok(narrow[SEARCH_ROW].includes('\u2026'), 'the query is elided at the pane edge');
    assert.equal(narrow[SEARCH_ROW].slice(2 + paneWidths(40).list, -2).trim(), '');
    for (const row of narrow) assert.equal(helpers.visibleWidth(row), 40);
    const wide = rowsOf(view);
    assert.ok(wide[SEARCH_ROW].includes(long), 'the full query fits the wider list pane');
    assert.equal(wide[SEARCH_ROW].slice(2 + paneWidths().list, -2).trim(), '');
  });

  test('the body is two panes split by one rule, the list at 45% and capped at 64 columns', async () => {
    const { view } = await open();
    for (const [width, expected] of [[72, 30], [120, 52], [200, LIST_MAX_WIDTH]]) {
      const rows = rowsOf(view, width);
      for (const row of rows) assert.equal(helpers.visibleWidth(row), width, `no row is ragged at ${width}`);
      assert.equal(listWidth(rows), expected, `the list takes its share at ${width}`);
      const preview = [...rows[BODY_TOP]].length - 2 - previewStart(rows);
      assert.equal(preview, width - 4 - expected - 3, `the preview keeps the rest at ${width}`);
      assert.equal((rows[BODY_TOP].match(/│/g) || []).length >= 3, true, 'the panes are ruled apart');
    }
  });
});

describe('the footer (S4)', () => {
  test('names one option per key and never advertises the compatible alternates', async () => {
    const { view } = await open();
    // S32: the flat order paints no group, so its footer names no fold key.
    const flat = footerOf(rowsOf(view, 200));
    for (const token of [
      '↑/↓ move', 'tab select', 'ctrl+j/k scroll', 'ctrl+o order',
      'ctrl+u clear', 'ctrl+e edit', 'enter insert', 'esc close',
    ]) {
      assert.ok(flat.includes(token), `the footer names ${token}: ${flat}`);
    }
    for (const hidden of ['space', 'fold', 'ctrl+k', 'ctrl+shift', 'ctrl+c', 'esc/', 'home', 'end', 'enter/']) {
      assert.ok(!flat.includes(hidden), `the flat footer never names ${hidden}: ${flat}`);
    }
    assert.ok(flat.endsWith('esc close'), `the flat footer ends at its last key, not at an order name: ${flat}`);

    // S32, S40: the trees earn the two fold keys, in the same one-key style, and the
    // shift+space one names the action it would perform.
    for (const [order, action] of [['tree', 'shift+space expand all'], ['ext', 'shift+space collapse all']]) {
      view.handleInput('ctrl+o');
      const tree = footerOf(rowsOf(view, 200));
      for (const token of ['space fold', action, 'ctrl+u clear', 'ctrl+e edit', 'enter insert', 'esc close']) {
        assert.ok(tree.includes(token), `the ${order} footer names ${token}: ${tree}`);
      }
      assert.ok(tree.endsWith('esc close'), `the ${order} footer ends at its last key: ${tree}`);
      assert.match(infoCell(rowsOf(view, 200), 200), new RegExp(` ${order}$`), `the info row names the ${order} order`);
    }
  });

  test('paints each key in the key role and its description muted', async () => {
    const theme = recordingTheme();
    const { view } = await open({ theme });
    view.render(200);
    for (const [keyText, rest] of [['↑/↓', ' move'], ['ctrl+o', ' order'], ['esc', ' close']]) {
      assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === keyText), keyText);
      assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text === rest), rest);
    }
  });

  test('a narrow footer compacts onto the one row instead of wrapping', async () => {
    const { view } = await open();
    // At 80 columns the substrate keeps every key and drops its word, so one
    // option per key still fits on one row. The flat order names no fold key (S32).
    const compact = rowsOf(view, 80);
    const footer = footerOf(compact);
    for (const keyName of ['↑/↓', 'tab', 'ctrl+o', 'ctrl+u', 'ctrl+e', 'enter', 'esc']) {
      assert.ok(footer.includes(keyName), `the footer keeps ${keyName}: ${footer}`);
    }
    assert.ok(!footer.includes(' move'), `the words give way first: ${footer}`);
    assert.equal(compact.length, CARD_HEIGHT, 'the footer never adds a row');
    for (const row of compact) assert.equal(helpers.visibleWidth(row), 80);

    // In a tree the two fold keys join the compact legend (S32, S40): at the default
    // width both are named, and at 80 the longer legend still fits one row.
    view.handleInput('ctrl+o');
    const roomy = footerOf(rowsOf(view));
    for (const keyName of ['space', 'shift+space']) {
      assert.ok(roomy.includes(keyName), `the tree footer names ${keyName}: ${roomy}`);
    }
    const treeRows = rowsOf(view, 80);
    assert.ok(footerOf(treeRows).includes('space'), `the tree keeps its fold key: ${footerOf(treeRows)}`);
    assert.equal(treeRows.length, CARD_HEIGHT, 'the longer legend never adds a row');
    for (const row of treeRows) assert.equal(helpers.visibleWidth(row), 80);

    // Narrower still: only the highest-priority keys survive, on the same row.
    const tiny = rowsOf(view, 40);
    const dropped = footerOf(tiny);
    assert.ok(dropped.includes('esc'), `esc never gives way: ${dropped}`);
    assert.ok(!dropped.includes('ctrl+j/k') && !dropped.includes('ctrl+u'), `the least important keys give way: ${dropped}`);
    assert.equal(tiny.length, CARD_HEIGHT);
    for (const row of tiny) assert.equal(helpers.visibleWidth(row), 40);
  });

  test('the active order is named once, on the info row, and never again in the footer', async () => {
    const { view } = await open();
    for (const order of ['files', 'tree', 'ext', 'files']) {
      const rows = rowsOf(view);
      assert.match(infoCell(rows), new RegExp(` ${order}$`), `S33/S23: the info row names the ${order} order`);
      const footer = footerOf(rows);
      assert.match(footer, /esc( close)?$/, `the footer is the legend alone and ends at its last key: ${footer}`);
      assert.doesNotMatch(footer, / {2,}(files|tree|ext)$/, `the footer does not repeat the ${order} order at its right edge: ${footer}`);
      view.handleInput('ctrl+o');
    }
  });
});

describe('the list rows (S6, S15)', () => {
  test('changed files paint their letter and age at the right; a clean row paints neither', async () => {
    const { view } = await open();
    const rows = rowsOf(view);
    assert.match(listCell(rows, 'brand-new.ts'), /^▸\s+brand-new\.ts +U 5s$/);
    assert.match(listCell(rows, 'cursor.ts'), /^\s+cursor\.ts  src +M 2h$/);
    assert.match(listCell(rows, 'README.md'), /^\s+README\.md *$/, 'a clean row has no badge and no age');
    assert.ok(!bodyText(rows).includes('new '), 'the word badge is never painted');
  });

  test('a changed row without an age keeps its letter and falls back to its mtime once', async () => {
    const entries = [
      { path: 'brand-new.ts', state: 'new' },
      { path: 'edited.ts', state: 'updated', mtimeMs: NOW - 3 * HOUR },
      { path: 'plain.ts', state: 'clean' },
    ];
    const { view } = await open({ entries, now: NOW });
    assert.match(listCell(rowsOf(view), 'brand-new.ts'), /U$/);
    assert.match(listCell(rowsOf(view), 'edited.ts'), /M 3h$/, 'the mtime and the injected clock decide the age');
    // The clock is read once when the panel opens, so no repaint can move the age.
    view.handleInput('tab');
    view.handleInput('tab');
    assert.match(listCell(rowsOf(view), 'edited.ts'), /M 3h$/, 'ages are computed once and never refreshed live');
  });

  test('a name paints in the row role and its trailing directory in dim, never at the root', async () => {
    const theme = recordingTheme();
    const { view } = await open({ theme });
    const rows = rowsOf(view);
    view.render(WIDTH);
    assert.ok(theme.calls.some((call) => call.role === 'text' && call.text === 'util.ts'), 'the name is the plain text role');
    assert.ok(theme.calls.some((call) => call.role === 'dim' && call.text === 'src/lib'), 'the directory is dim');
    assert.ok(!theme.calls.some((call) => call.role === 'dim' && call.text.includes('README')), 'a root file has no directory');
    assert.equal(listCell(rows, 'README.md').trim(), 'README.md', 'a root file paints its name alone');
  });

  test('the tree order paints no trailing directory, because the tree already places it', async () => {
    const { view } = await open();
    // S30: focus a file inside the tree first, so the change opens its folders.
    for (let step = 0; step < 3; step += 1) view.handleInput('down'); // src/lib/util.ts
    view.handleInput('ctrl+o');
    const rows = rowsOf(view);
    assert.ok(!listCell(rows, 'util.ts').includes('src/lib'), listCell(rows, 'util.ts'));
    const painted = rows
      .slice(BODY_TOP, rows.length - 2)
      .map((row) => (row.split(' │ ')[0] || '').replace(/^│ /, '').trim());
    // S29: a group row also carries its chevron, so the cell ends with the name.
    assert.ok(painted.some((cell) => cell.endsWith('src')), 'the folder group paints its own row');
    assert.ok(painted.some((cell) => cell.endsWith('lib')), 'the nested folder paints its own row');
    assert.ok(
      painted.findIndex((cell) => cell.endsWith('src')) < painted.findIndex((cell) => cell.endsWith('util.ts')),
      'the tree places the file under its folder',
    );
  });

  test('a narrow pane costs the name before the badge', async () => {
    const entries = [
      { path: 'a-very-long-file-name-that-will-not-fit.ts', state: 'new', mtimeMs: NOW - 5 * MINUTE, age: '5m' },
      { path: 'b.ts', state: 'clean' },
    ];
    const { view } = await open({ entries });
    const rows = rowsOf(view, 40);
    const changed = listCell(rows, 'U 5m');
    assert.ok(changed.includes('U 5m'), changed);
    assert.ok(changed.includes('\u2026'), `the name is elided: ${changed}`);
    assert.ok(!changed.includes('a-very-long-file-name-that-will-not-fit.ts'));
    for (const row of rows) assert.equal(helpers.visibleWidth(row), 40);
  });

  test('a long list keeps the selection visible with more indicators', async () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      path: `file-${String(index).padStart(2, '0')}.ts`,
      state: 'clean',
    }));
    const { view } = await open({ entries });
    for (let step = 0; step < 20; step += 1) view.handleInput('down');
    const rows = rowsOf(view);
    assert.match(selectedRow(rows), /file-20\.ts/);
    assert.match(bodyText(rows), /↑ \d+ more/);
    assert.match(bodyText(rows), /↓ \d+ more/);
    for (const row of rows) assert.equal(helpers.visibleWidth(row), WIDTH);
  });
});

describe('search is always active (S2, S3)', () => {
  test('typing filters immediately, paints the query and resets the highlight to the first file', async () => {
    const entries = [
      { path: 'alpha.ts', state: 'clean' },
      { path: 'alpine.ts', state: 'clean' },
      { path: 'src/beta.ts', state: 'clean' },
    ];
    const { view, calls } = await open({ entries });
    view.handleInput('down');
    assert.match(selectedRow(rowsOf(view)), /alpine\.ts/);
    for (const character of 'al') view.handleInput(character);
    const rows = rowsOf(view);
    assert.ok(rows[SEARCH_ROW].startsWith('│ › al'), rows[SEARCH_ROW]);
    assert.ok(!rows[SEARCH_ROW].includes('Search'), 'the placeholder gives way to the query');
    assert.ok(bodyText(rows).includes('alpha.ts'));
    assert.ok(bodyText(rows).includes('alpine.ts'));
    assert.ok(!bodyText(rows).includes('beta.ts'), 'a non-matching file disappears immediately');
    assert.match(selectedRow(rows), /alpha\.ts/, 'the highlight returns to the first match');
    assert.deepEqual(calls.insert, []);
    assert.deepEqual(calls.open, []);
    assert.equal(calls.close, 0, 'typing never closes the panel');
  });

  test('a query matching nothing paints an explicit empty-state line', async () => {
    const { view } = await open();
    for (const character of 'zzz') view.handleInput(character);
    const rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('No files match "zzz"'), bodyText(rows));
    assert.equal(rows.length, CARD_HEIGHT, 'the card keeps its chrome');
  });

  test('backspace edits one character, ctrl+u clears, and a paste is never a keystroke', async () => {
    const { view } = await open();
    for (const character of 'brand') view.handleInput(character);
    assert.ok(bodyText(rowsOf(view)).includes('brand-new.ts'));
    view.handleInput('x');
    assert.ok(bodyText(rowsOf(view)).includes('No files match "brandx"'));
    view.handleInput('backspace');
    assert.ok(bodyText(rowsOf(view)).includes('brand-new.ts'), 'backspace edits the query');
    view.handleInput('ctrl+u');
    assert.ok(bodyText(rowsOf(view)).includes('README.md'), 'ctrl+u clears the query');
    view.handleInput('brand');
    assert.ok(bodyText(rowsOf(view)).includes('README.md'), 'a multi-character paste never lands in the query');
  });
});

describe('the listing load (S13)', () => {
  test('the first frame paints the pending state and never blocks, then the listing appears', async () => {
    const mounted = mount();
    mounted.view.render(WIDTH);
    assert.ok(bodyText(rowsOf(mounted.view)).includes('Loading files'), 'the first frame is honest about the read');
    assert.equal(mounted.renderCount(), 0, 'the load blocks nothing and paints nothing by itself');
    await tick();
    mounted.view.render(WIDTH);
    assert.ok(bodyText(rowsOf(mounted.view)).includes('brand-new.ts'));
    assert.equal(mounted.renderCount(), 1, 'the landed listing asks for one repaint');
  });

  test('a failed listing paints its own message in the error role and no loading row', async () => {
    const theme = recordingTheme();
    const { view } = await open({
      theme,
      loadEntries: async () => ({ ok: false, message: 'Not a Git repository: /nowhere.' }),
    });
    const body = bodyText(rowsOf(view));
    assert.ok(body.includes('Not a Git repository: /nowhere.'), body);
    assert.ok(!body.includes('Loading files'));
    assert.ok(theme.calls.some((call) => call.role === 'error' && call.text.includes('Not a Git repository')));
  });

  test('an empty repository says so, and a rejecting reader keeps its own sentence', async () => {
    const empty = await open({ entries: [] });
    assert.ok(bodyText(rowsOf(empty.view)).includes('No files in this repository.'));

    const rejected = await open({ loadEntries: async () => { throw new Error('no listing'); } });
    assert.ok(bodyText(rowsOf(rejected.view)).includes('Cannot list repository files: no listing.'));
  });

  test('the selection and the hover survive a preview landing and an ordinary repaint', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const theme = recordingTheme();
    const mounted = mount({ theme, loadPreview: () => gate });
    mounted.view.render(WIDTH);
    await tick();
    mounted.view.render(WIDTH);
    mounted.view.handleInput('down');
    mounted.view.handleInput('down');
    let rows = rowsOf(mounted.view);
    assert.match(selectedRow(rows), /README\.md/);
    mounted.view.handleMouse(mouse({ type: 'move', button: 'none', y: rowOf(rows, 'cursor.ts') }));
    rows = rowsOf(mounted.view);
    assert.ok(mounted.view.render(WIDTH)[rowOf(rows, 'cursor.ts')].includes('\x1b[96m'), 'the hovered row is painted');

    release(preview(['landed']));
    await tick();
    rows = rowsOf(mounted.view);
    assert.match(selectedRow(rows), /README\.md/, 'the selection survives the repaint');
    assert.ok(mounted.view.render(WIDTH)[rowOf(rows, 'cursor.ts')].includes('\x1b[96m'), 'so does the hover');
    assert.ok(bodyText(rows).includes('landed'), 'the preview landed');
  });
});

describe('keys (S4)', () => {
  test('the arrows move the selection and clamp at both ends', async () => {
    const { view, calls } = await open();
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/);
    view.handleInput('down');
    assert.match(selectedRow(rowsOf(view)), /cursor\.ts/);
    view.handleInput('up');
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/);
    view.handleInput('up');
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/, 'the selection clamps at the top');
    for (let step = 0; step < 6; step += 1) view.handleInput('down');
    assert.match(selectedRow(rowsOf(view)), /util\.ts/, 'the selection clamps at the bottom');
    assert.deepEqual(calls.insert, []);
    assert.equal(calls.close, 0);
  });

  test('ctrl+j/k and the ctrl+shift forms scroll the preview and never move the selection', async () => {
    const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const { view, calls } = await open({ loadPreview: async () => preview(long) });
    assert.match(previewPane(rowsOf(view), 0), /^│ 1 line 0/, 'the box starts at line 1');
    view.handleInput('ctrl+j');
    assert.match(previewPane(rowsOf(view), 0), /^│ 2 line 1/, 'ctrl+j scrolls one row');
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/, 'a scroll never moves the selection');
    view.handleInput('ctrl+k');
    assert.match(previewPane(rowsOf(view), 0), /^│ 1 line 0/);
    view.handleInput('ctrl+shift+j');
    assert.match(previewPane(rowsOf(view), 0), /^│ 2 line 1/, 'the ctrl+shift form scrolls too');
    view.handleInput('ctrl+shift+k');
    assert.match(previewPane(rowsOf(view), 0), /^│ 1 line 0/);
    for (let step = 0; step < 200; step += 1) view.handleInput('ctrl+j');
    const clamped = rowsOf(view);
    assert.match(previewPane(clamped, 0), /^│51 line 50/, 'scrolling stops at the last full page');
    assert.ok(bodyText(clamped).includes('line 59'), 'the last line is painted on that page');
    const renders = calls.render;
    view.handleInput('ctrl+j');
    assert.equal(calls.render, renders, 'a clamped scroll repaints nothing');
    assert.deepEqual(calls.insert, []);
  });

  test('home/end reach the first and last ROW, group rows included (S38)', async () => {
    const { view } = await open();
    // S30: a file inside the tree stays highlighted across the order change, which
    // is what leaves its folders open under the fully-folded default.
    for (let step = 0; step < 3; step += 1) view.handleInput('down'); // src/lib/util.ts
    view.handleInput('ctrl+o');
    assert.match(selectedRow(rowsOf(view)), /util\.ts/);
    view.handleInput('home');
    assert.equal(selectedName(rowsOf(view)), 'src', 'S38: the first row of the tree is its first folder');
    view.handleInput('end');
    assert.equal(selectedName(rowsOf(view)), 'brand-new.ts', 'the last row');
  });

  test('ctrl+home and ctrl+end reach the preview edges', async () => {
    const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const { view } = await open({ loadPreview: async () => preview(long) });
    for (let step = 0; step < 5; step += 1) view.handleInput('ctrl+j');
    assert.match(previewPane(rowsOf(view), 0), /^│ 6 line 5/);
    view.handleInput('ctrl+home');
    assert.match(previewPane(rowsOf(view), 0), /^│ 1 line 0/);
    view.handleInput('ctrl+end');
    assert.match(previewPane(rowsOf(view), 0), /^│51 line 50/, 'ctrl+end lands on the last page');
  });

  test('tab marks the highlighted file in place, in one constant column, and toggles off', async () => {
    const { view } = await open();
    let rows = rowsOf(view);
    assert.equal(listCell(rows, 'brand-new.ts').indexOf('brand-new.ts'), 3, 'the marker column is three cells');
    assert.ok(!bodyText(rows).includes('\u258f'), 'nothing is marked before Tab');
    view.handleInput('tab');
    rows = rowsOf(view);
    assert.match(listCell(rows, 'brand-new.ts'), /^▸▏ brand-new\.ts/, 'the bar lands in its own column');
    assert.match(selectedRow(rows), /▸/, 'the highlight stays');
    assert.equal(listCell(rows, 'README.md').indexOf('README.md'), 3, 'an unmarked row keeps the column');
    assert.ok(!listCell(rows, 'README.md').includes('\u258f'));
    view.handleInput('tab');
    assert.ok(!bodyText(rowsOf(view)).includes('\u258f'), 'Tab twice clears the mark');
  });

  test('enter inserts every selected file plus the highlighted one, in list order, then closes', async () => {
    const entries = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => ({ path, state: 'clean' }));
    const { view, calls } = await open({ entries });
    for (let step = 0; step < 3; step += 1) view.handleInput('down');
    view.handleInput('tab');
    view.handleInput('up');
    view.handleInput('up');
    view.handleInput('tab');
    assert.deepEqual(calls.insert, [], 'Tab never inserts');
    view.handleInput('enter');
    assert.deepEqual(calls.insert, [['b.ts', 'd.ts']], 'list order, not marking order');
    assert.equal(calls.close, 1);
    view.handleInput('enter');
    view.handleInput('escape');
    assert.deepEqual(calls.insert, [['b.ts', 'd.ts']], 'a settled panel cannot fire again');
    assert.equal(calls.close, 1);
  });

  test('enter adds a highlighted file that Tab never marked, and never duplicates one', async () => {
    const entries = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, state: 'clean' }));
    const once = await open({ entries });
    once.view.handleInput('tab');
    once.view.handleInput('enter');
    assert.deepEqual(once.calls.insert, [['a.ts']], 'the highlighted file is not duplicated');

    const twice = await open({ entries });
    twice.view.handleInput('down');
    twice.view.handleInput('tab');
    twice.view.handleInput('down');
    twice.view.handleInput('enter');
    assert.deepEqual(twice.calls.insert, [['b.ts', 'c.ts']]);
  });

  test('a selection a query hides is inserted after the visible ones', async () => {
    const entries = ['alpha.ts', 'beta.ts', 'gamma.ts'].map((path) => ({ path, state: 'clean' }));
    const { view, calls } = await open({ entries });
    view.handleInput('down');
    view.handleInput('tab');
    for (const character of 'al') view.handleInput(character);
    view.handleInput('tab');
    view.handleInput('enter');
    assert.deepEqual(calls.insert, [['alpha.ts', 'beta.ts']], 'the hidden mark keeps its own order');
    assert.equal(calls.close, 1);
  });

  test('a click parks the cursor on a group row and folds it, and space folds the group holding the file', async () => {
    const { view, calls } = await open();
    view.handleInput('ctrl+o'); // tree, opened with every group collapsed (S29)
    let rows = rowsOf(view);
    assert.ok(!bodyText(rows).includes('util.ts'), 'every group starts collapsed');
    assert.match(selectedRow(rows), /brand-new\.ts/);
    // S38 replaces S24's "a click folds it without focusing it": the click parks
    // the cursor on the group row AND folds it, so `space` has the row (S43 leaves
    // `enter` to insert, and only the Tab marks on a group row).
    assert.deepEqual(view.handleMouse(mouse({ y: BODY_TOP })), { handled: true, render: true });
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('cursor.ts'), 'the click opened the folder');
    assert.ok(!bodyText(rows).includes('util.ts'), 'its own subfolder stays exactly as it was');
    assert.ok(bodyText(rows).includes('src'), 'the group row stays');
    assert.equal(selectedName(rows), 'src', 'the click parks the cursor on the group row');
    assert.deepEqual(calls.insert, [], 'a group row never inserts');
    assert.equal(calls.close, 0);
    // A second click closes it again.
    assert.deepEqual(view.handleMouse(mouse({ y: BODY_TOP })), { handled: true, render: true });
    assert.ok(!bodyText(rowsOf(view)).includes('cursor.ts'), 'the click collapsed the group');
    // space on a file folds the folder that HOLDS it, never a row of its own.
    view.handleMouse(mouse({ y: BODY_TOP })); // src
    view.handleMouse(mouse({ y: BODY_TOP + 1 })); // src/lib
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('util.ts'), 'both folders are open');
    view.handleMouse(mouse({ y: BODY_TOP + 2 })); // src/lib/util.ts
    assert.equal(selectedName(rowsOf(view)), 'util.ts', 'the click selected the file');
    view.handleInput('space');
    rows = rowsOf(view);
    assert.ok(!bodyText(rows).includes('util.ts'), 'space folded the folder holding it');
    assert.ok(bodyText(rows).includes('lib'), 'the folder row stays');
    assert.equal(selectedName(rows), 'lib', 'S38: the cursor parks on the group row that held the file');

    // S30 replaces S10's per-order memory: choosing the tree again re-seeds its
    // folds to the focused file's path, so the folder just folded is open again.
    view.handleInput('space'); // reopen the folder from its own row
    view.handleInput('down'); // and step back onto the file it holds
    assert.equal(selectedName(rowsOf(view)), 'util.ts');
    view.handleInput('ctrl+o'); // ext
    assert.ok(bodyText(rowsOf(view)).includes('.md'), 'the ext order paints its own groups');
    view.handleInput('ctrl+o'); // files
    view.handleInput('ctrl+o'); // tree again
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('cursor.ts'), 'the focused file path is open again (S30)');
    assert.ok(bodyText(rows).includes('util.ts'), 'and so is the nested folder that holds it');
    assert.deepEqual(groupCells(rows), [' ▾ src', ' ▾   lib'], 'no fold the reader left behind is remembered');
  });

  test('a non-empty query forces every group open and makes the fold keys inert', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o');
    // S29: the tree is fully collapsed, and the query below is what opens it.
    assert.ok(!bodyText(rowsOf(view)).includes('util.ts'));
    for (const character of 'util') view.handleInput(character);
    assert.ok(bodyText(rowsOf(view)).includes('util.ts'), 'a match is never hidden behind a fold');
    view.handleInput('space');
    assert.ok(bodyText(rowsOf(view)).includes('util.ts'), 'the fold key does nothing while a query is active');
    view.handleInput('shift+space');
    assert.ok(bodyText(rowsOf(view)).includes('util.ts'), 'neither does the fold-all key');
    view.handleInput('ctrl+u');
    assert.ok(!bodyText(rowsOf(view)).includes('util.ts'), 'the fold the query overrode is back once it clears');
  });

  test('ctrl+o keeps the same file highlighted and repaints the order', async () => {
    const { view } = await open();
    view.handleInput('down');
    view.handleInput('ctrl+o');
    assert.match(selectedRow(rowsOf(view)), /cursor\.ts/);
    assert.match(infoCell(rowsOf(view)), / tree$/, 'the repainted order is named on the info row');
  });

  test('ctrl+e opens the highlighted file and closes, with no repaint before the terminal stops', async () => {
    const { view, calls } = await open();
    view.handleInput('down');
    const renders = calls.render;
    view.handleInput('ctrl+e');
    assert.deepEqual(calls.open, ['src/cursor.ts']);
    assert.equal(calls.close, 1);
    assert.equal(calls.render, renders, 'the handoff never repaints first');
    view.handleInput('ctrl+e');
    assert.deepEqual(calls.open, ['src/cursor.ts'], 'the panel is settled');
    assert.deepEqual(calls.insert, []);
  });

  test('escape and ctrl+c close once, and later keys are ignored', async () => {
    const escaped = await open();
    escaped.view.handleInput('escape');
    assert.equal(escaped.calls.close, 1);
    escaped.view.handleInput('escape');
    assert.equal(escaped.calls.close, 1);

    const ctrlC = await open();
    ctrlC.view.handleInput('ctrl+c');
    assert.equal(ctrlC.calls.close, 1);
    ctrlC.view.handleInput('tab');
    ctrlC.view.handleInput('enter');
    assert.deepEqual(ctrlC.calls.insert, []);
  });

  test('a key release is ignored', async () => {
    const { view, calls } = await open();
    view.handleInput('release');
    view.handleInput('release');
    assert.equal(calls.close, 0);
    view.handleInput('escape');
    assert.equal(calls.close, 1);
  });

  test('a throwing insert or editor callback still closes the panel exactly once', async () => {
    const insert = await open({ onInsert() { throw new Error('paste failed'); } });
    assert.throws(() => insert.view.handleInput('enter'), /paste failed/);
    assert.equal(insert.calls.close, 1);
    insert.view.handleInput('enter');
    assert.equal(insert.calls.close, 1);

    const editor = await open({ onOpen() { throw new Error('editor failed'); } });
    assert.throws(() => editor.view.handleInput('ctrl+e'), /editor failed/);
    assert.equal(editor.calls.close, 1);
    editor.view.handleInput('ctrl+e');
    assert.equal(editor.calls.close, 1);
  });

  test('a hostile key matcher still routes the spelled sequences', async () => {
    const { view, calls } = await open({
      helpers: { ...helpers, matchesKey() { throw new Error('no matcher'); } },
    });
    view.handleInput('\x1b[B');
    assert.match(selectedRow(rowsOf(view)), /cursor\.ts/);
    view.handleInput('\r');
    assert.deepEqual(calls.insert, [['src/cursor.ts']]);
    assert.equal(calls.close, 1);
  });
});

describe('mouse (S5)', () => {
  test('a click selects the row under it, including the list pane\u2019s last column', async () => {
    const entries = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, state: 'clean' }));
    const { view, calls } = await open({ entries });
    let rows = rowsOf(view);
    const target = rowOf(rows, 'b.ts');
    assert.deepEqual(view.handleMouse(mouse({ y: target })), { handled: true, render: true });
    rows = rowsOf(view);
    assert.match(selectedRow(rows), /b\.ts/);
    assert.equal(rowOf(rows, '▸'), target, 'the selection lands on the row that was under the pointer');

    const lastColumn = 2 + listWidth(rows) - 1;
    assert.deepEqual(view.handleMouse(mouse({ x: lastColumn, y: rowOf(rows, 'c.ts') })), { handled: true, render: true });
    assert.match(selectedRow(rowsOf(view)), /c\.ts/);
    assert.deepEqual(calls.insert, []);
    assert.equal(calls.close, 0);
  });

  test('a press claims the gesture and a preview click is absorbed', async () => {
    const { view, calls } = await open();
    let rows = rowsOf(view);
    assert.deepEqual(view.handleMouse(mouse({ type: 'press', y: rowOf(rows, 'README.md') })), { handled: true, render: false });
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/, 'a press selects nothing');
    rows = rowsOf(view);
    assert.deepEqual(view.handleMouse(mouse({ x: previewStart(rows) + 1, y: BODY_TOP })), { handled: true, render: false });
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/);
    assert.deepEqual(calls.insert, []);
    assert.equal(calls.close, 0);
  });

  test('the wheel over the list moves the selection and never scrolls the preview', async () => {
    const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const entries = [{ path: 'a.ts', state: 'clean' }, { path: 'b.ts', state: 'clean' }];
    const { view } = await open({ entries, loadPreview: async (path) => preview(long.map((line) => `${path} ${line}`)) });
    for (let step = 0; step < 5; step += 1) view.handleInput('ctrl+j');
    assert.ok(bodyText(rowsOf(view)).includes('a.ts line 5'), 'the preview is scrolled before the wheel');

    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, y: BODY_TOP })),
      { handled: true, render: true },
    );
    let rows = rowsOf(view);
    assert.match(selectedRow(rows), /b\.ts/, 'the list wheel moves the selection');
    await tick();
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('b.ts line 0'), 'the preview follows the file, at its own top');
  });

  test('the preview wheel scrolls the preview, never the selection, and clamps', async () => {
    const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const { view } = await open({ entries: [{ path: 'a.ts', state: 'clean' }], loadPreview: async () => preview(long) });
    for (let step = 0; step < 5; step += 1) view.handleInput('ctrl+j');
    let rows = rowsOf(view);
    assert.match(previewPane(rows, 0), /^│ 6 line 5/);

    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, y: BODY_TOP })),
      { handled: true, render: false },
      'a one-file list has nowhere to move',
    );
    rows = rowsOf(view);
    assert.match(previewPane(rows, 0), /^│ 6 line 5/, 'the list wheel never scrolls the preview');

    const previewX = previewStart(rows) + 2;
    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: previewX, y: BODY_TOP })),
      { handled: true, render: true },
    );
    rows = rowsOf(view);
    assert.match(previewPane(rows, 0), /^│ 7 line 6/, 'the preview wheel scrolls the preview');
    assert.match(selectedRow(rows), /a\.ts/, 'and never moves the selection');

    for (let step = 0; step < 200; step += 1) {
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: previewX, y: BODY_TOP }));
    }
    rows = rowsOf(view);
    assert.match(previewPane(rows, 0), /^│51 line 50/);
    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: previewX, y: BODY_TOP })),
      { handled: true, render: false },
      'a clamped preview wheel repaints nothing',
    );
    assert.equal(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: 1, y: BODY_TOP })),
      undefined,
      'the wheel outside both panes is not handled',
    );
  });

  test('hover paints the row in the key role and clears when the pointer leaves', async () => {
    const theme = recordingTheme();
    const { view } = await open({ theme });
    let rows = rowsOf(view);
    assert.deepEqual(view.handleMouse(mouse({ type: 'move', button: 'none', y: rowOf(rows, 'README.md') })), { handled: true, render: true });
    rows = rowsOf(view);
    assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === 'README.md'), 'the hovered name takes the key role');
    assert.deepEqual(view.handleMouse(mouse({ type: 'move', button: 'none', y: BODY_TOP - 1 })), { handled: true, render: true });
    const callsBefore = theme.calls.length;
    view.render(WIDTH);
    assert.ok(!theme.calls.slice(callsBefore).some((call) => call.role === 'accent' && call.text === 'README.md'));
  });

  test('events from another geometry, or from outside the card, are not handled', async () => {
    const { view } = await open();
    view.render(WIDTH);
    assert.equal(view.handleMouse(mouse({ x: 1, y: BODY_TOP })), undefined);
    assert.equal(view.handleMouse(mouse({ y: 0 })), undefined);
    assert.equal(view.handleMouse(mouse({ y: 200 })), undefined);
    assert.equal(view.handleMouse(mouse({ width: 60 })), undefined);
    assert.equal(view.handleMouse(null), undefined);
    assert.equal(view.handleMouse({ type: 'click', button: 'right', x: 3, y: BODY_TOP, width: WIDTH, height: CARD_HEIGHT }), undefined);

    view.handleMouse(mouse({ type: 'move', button: 'none', y: BODY_TOP }));
    view.invalidate();
    assert.equal(view.handleMouse(mouse({ y: BODY_TOP })), undefined, 'invalidate drops the hit geometry');
    view.render(WIDTH);
    view.handleInput('escape');
    assert.equal(view.handleMouse(mouse({ y: BODY_TOP })), undefined, 'a settled panel takes no mouse');
  });

  test('dispose stops the input and the mouse routes', async () => {
    const { view, calls } = await open();
    view.render(WIDTH);
    view.dispose();
    view.handleInput('down');
    view.handleInput('escape');
    assert.equal(calls.close, 0);
    assert.equal(view.handleMouse(mouse({})), undefined);
  });
});

describe('the info row (S22)', () => {
  test('counts the listed files out of the total, the Tab selection, then the order at the list edge', async () => {
    const { view } = await open();
    const rows = rowsOf(view);
    assert.equal(infoCell(rows).length, listWidth(rows), 'the info row fills exactly the list column');
    assert.match(infoCell(rows), /^4\/4 \(0\) ─+ files$/, infoCell(rows));
    view.handleInput('tab');
    assert.match(infoCell(rowsOf(view)), /^4\/4 \(1\) ─+ files$/, 'the Tab mark is counted');
    view.handleInput('down');
    view.handleInput('tab');
    assert.match(infoCell(rowsOf(view)), /^4\/4 \(2\) ─+ files$/);
    view.handleInput('tab');
    assert.match(infoCell(rowsOf(view)), /^4\/4 \(1\) ─+ files$/, 'unmarking counts back down');
  });

  test('the listed count follows the query while the total stays the whole listing', async () => {
    const { view } = await open();
    for (const character of 'util') view.handleInput(character);
    assert.match(infoCell(rowsOf(view)), /^1\/4 \(0\) ─+ files$/);
    for (const character of 'zzz') view.handleInput(character);
    assert.match(infoCell(rowsOf(view)), /^0\/4 \(0\) ─+ files$/, 'a query that matches nothing lists none');
    view.handleInput('ctrl+u');
    assert.match(infoCell(rowsOf(view)), /^4\/4 \(0\) ─+ files$/);
  });

  test('the order is right-aligned at the list edge and follows ctrl+o', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o');
    assert.match(infoCell(rowsOf(view)), /^4\/4 \(0\) ─+ tree$/, 'S23: the folder order is named tree');
    view.handleInput('ctrl+o');
    assert.match(infoCell(rowsOf(view)), /^4\/4 \(0\) ─+ ext$/);
    assert.equal(infoCell(rowsOf(view)).length, listWidth(rowsOf(view)), 'the order sits at the list pane edge');
  });

  test('a pending or failed listing counts zero and still paints its own line', async () => {
    const pending = mount({ loadEntries: () => new Promise(() => {}) });
    const rows = pending.view.render(WIDTH).map(strip);
    assert.match(infoCell(rows), /^0\/0 \(0\) ─+ files$/);
    assert.ok(bodyText(rows).includes('Loading files'), 'a pending listing still says so');

    const failed = await open({ loadEntries: async () => ({ ok: false, message: 'Not a Git repository: /nowhere.' }) });
    assert.match(infoCell(rowsOf(failed.view)), /^0\/0 \(0\) ─+ files$/);
    assert.ok(bodyText(rowsOf(failed.view)).includes('Not a Git repository: /nowhere.'), 'a failed listing still says so');
  });

  test('the info row fits the narrowest card without overflowing its column', async () => {
    const { view } = await open();
    for (const width of [20, 24, 40, 72, 200]) {
      const rows = rowsOf(view, width);
      for (const row of rows) assert.equal(helpers.visibleWidth(row), width, `no row is ragged at ${width}`);
      const info = infoCell(rows, width);
      assert.ok(helpers.visibleWidth(info) <= paneWidths(width).list, `the info row stays inside its column at ${width}`);
      assert.ok(info.includes('/'), `the counts survive ${width}: ${info}`);
    }
  });
});

describe('every row of tree and ext takes the cursor (S38)', () => {
  test('the arrows and home/end park the cursor on a group row exactly as on a file row', async () => {
    const { view, calls } = await open();
    view.handleInput('ctrl+o'); // tree, every group collapsed: [src] README.md brand-new.ts
    view.handleInput('home');
    assert.equal(selectedName(rowsOf(view)), 'src', 'home reaches the first row, the folder group');
    const walked = [];
    for (let step = 0; step < 4; step += 1) {
      walked.push(selectedName(rowsOf(view)));
      view.handleInput('down');
    }
    assert.deepEqual(walked, ['src', 'README.md', 'brand-new.ts', 'brand-new.ts'],
      'walking down visits the group row and every file row, and clamps on the last one');
    view.handleInput('home');
    view.handleInput('up');
    assert.equal(selectedName(rowsOf(view)), 'src', 'the cursor clamps on the first row, the group');
    view.handleInput('end');
    assert.equal(selectedName(rowsOf(view)), 'brand-new.ts', 'end is the last row');

    // `ext`: its extension groups are rows the cursor takes too.
    view.handleInput('ctrl+o'); // ext: [.md] [.ts] brand-new.ts cursor.ts util.ts
    view.handleInput('home');
    assert.equal(selectedName(rowsOf(view)), '.md', 'the ext order starts on its first extension row');
    view.handleInput('down');
    assert.equal(selectedName(rowsOf(view)), '.ts', 'the cursor walks the extension rows too');
    view.handleInput('down');
    assert.equal(selectedName(rowsOf(view)), 'brand-new.ts', 'and continues into the files');
    assert.deepEqual(calls.insert, []);
    assert.equal(calls.close, 0);
  });

  test('the wheel and the page moves park the cursor on a group row too', async () => {
    const entries = ['a', 'b', 'c', 'd', 'e']
      .map((name) => ({ path: `src/${name}.ts`, state: 'clean' }))
      .concat([{ path: 'z.ts', state: 'clean' }]);
    const { view } = await open({ entries });
    view.handleInput('ctrl+o'); // tree: S30 opened `src`, the folder holding the focused file
    view.handleInput('home');
    assert.equal(selectedName(rowsOf(view)), 'src', 'the wheel below starts from the folder row');
    assert.equal(bodyCells(rowsOf(view))[0], '▸▾ src', 'the focused folder row paints its cursor and chevron');
    // S10 stands: space on a group row folds it, and S38 says the cursor stays there.
    view.handleInput('space');
    assert.equal(selectedName(rowsOf(view)), 'src', 'the folded folder keeps the cursor');
    assert.equal(bodyCells(rowsOf(view))[0], '▸▸ src', 'and paints its collapsed chevron');
    view.handleInput('space');
    assert.equal(bodyCells(rowsOf(view))[0], '▸▾ src', 'space reopened it from that same row');

    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, y: BODY_TOP })),
      { handled: true, render: true },
    );
    assert.equal(selectedName(rowsOf(view)), 'a.ts', 'the wheel moves off the group row');
    view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: -1, y: BODY_TOP }));
    assert.equal(selectedName(rowsOf(view)), 'src', 'and back onto it');

    // The page moves are compatibility bindings S4 never names (like home/end).
    view.handleInput('pagedown');
    assert.equal(selectedName(rowsOf(view)), 'z.ts', 'a page down clamps on the last row');
    view.handleInput('\x1b[5~');
    assert.equal(selectedName(rowsOf(view)), 'src', 'a page up from a raw sequence returns to the first row');
  });

  test('tab and enter on a group row mark and insert nothing, and the panel stays open', async () => {
    const entries = [{ path: 'src/a.ts', state: 'clean' }, { path: 'src/b.ts', state: 'clean' }];
    const { view, calls } = await open({ entries });
    view.handleInput('ctrl+o'); // tree: [src] a.ts b.ts
    view.handleInput('home');
    assert.equal(selectedName(rowsOf(view)), 'src');
    const before = rowsOf(view);
    assert.ok(bodyText(before).includes('a.ts'), 'the folder holding the focused file is open (S30)');
    const renders = calls.render;
    view.handleInput('tab');
    assert.deepEqual(rowsOf(view), before, 'tab changes nothing on a group row');
    assert.equal(calls.render, renders, 'so it repaints nothing');
    assert.ok(!bodyText(rowsOf(view)).includes(SELECTION_MARK), 'and it never marks the group');
    // S43: enter is only the insert key. With no Tab mark it sends nothing, keeps the
    // panel open and leaves the group exactly as it found it — never a fold.
    view.handleInput('enter');
    assert.deepEqual(calls.insert, [], 'enter on a group row inserts nothing');
    assert.equal(calls.close, 0, 'and leaves the panel open');
    const after = rowsOf(view);
    assert.deepEqual(after, before, 'enter folds nothing and repaints nothing else');
    assert.ok(bodyText(after).includes('a.ts'), 'the folder under the cursor is still open');
    // S43: with a Tab mark the same row sends the marks alone, once, and closes.
    view.handleInput('down');
    assert.equal(selectedName(rowsOf(view)), 'a.ts');
    view.handleInput('tab');
    view.handleInput('home');
    assert.equal(selectedName(rowsOf(view)), 'src', 'the cursor is back on the group row');
    view.handleInput('enter');
    assert.deepEqual(calls.insert, [['src/a.ts']], 'the Tab selection alone is the payload');
    assert.equal(calls.close, 1, 'and the panel closes');
  });

  test('the preview settles on a group row and the panel stays live', async () => {
    const { view, calls } = await open();
    view.handleInput('ctrl+o'); // tree, every group collapsed
    view.handleInput('home'); // the src group
    assert.equal(selectedName(rowsOf(view)), 'src');
    const rows = rowsOf(view);
    assert.ok(previewTop(rows).startsWith('╭'), `the preview keeps its box: ${previewTop(rows)}`);
    assert.ok(bodyText(rows).includes('No file selected.'), 'the pane says it shows no file');
    assert.ok(!/\d+\/\d+/.test(previewTop(rows)), 'and claims no line position');
    // The panel keeps answering: the group folds, nothing opens, escape still closes.
    view.handleInput('space');
    assert.ok(bodyText(rowsOf(view)).includes('cursor.ts'), 'space opened the focused group');
    view.handleInput('ctrl+e');
    assert.deepEqual(calls.open, [], 'a group row is never opened in the editor');
    assert.equal(calls.close, 0);
    view.handleInput('escape');
    assert.equal(calls.close, 1, 'the panel still closes');
  });

  test('a click folds a group while no query is active, and does nothing during one', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o'); // tree, every group collapsed (S29)
    for (const character of 'src') view.handleInput(character);
    assert.ok(bodyText(rowsOf(view)).includes('cursor.ts'), 'the query holds the groups open');
    assert.deepEqual(view.handleMouse(mouse({ y: BODY_TOP })), { handled: true, render: false });
    assert.ok(bodyText(rowsOf(view)).includes('cursor.ts'), 'a click cannot fold while a query is active');
    view.handleInput('ctrl+u');
    rowsOf(view); // a key invalidates the hit geometry; the host repaints
    view.handleMouse(mouse({ y: BODY_TOP }));
    assert.ok(bodyText(rowsOf(view)).includes('cursor.ts'), 'the cleared query leaves the group as it was, folded under S29');
    assert.ok(!bodyText(rowsOf(view)).includes('util.ts'), 'and a click opened only the row it landed on');
  });

  test('PRESERVE: the flat files order keeps its old arrow and space behaviour', async () => {
    // `files` paints no group row, so the new fold rules and the new cursor rule
    // must change nothing here: the arrows still clamp and `space` still does not
    // move the highlight.
    const { view, calls } = await open();
    view.handleInput('down');
    assert.match(selectedRow(rowsOf(view)), /cursor\.ts/);
    view.handleInput('space');
    assert.match(selectedRow(rowsOf(view)), /cursor\.ts/, 'nothing folds and the cursor stays');
    assert.ok(bodyText(rowsOf(view)).includes('util.ts'), 'every file row is still painted');
    for (let step = 0; step < 9; step += 1) view.handleInput('down');
    assert.match(selectedRow(rowsOf(view)), /util\.ts/);
    for (let step = 0; step < 9; step += 1) view.handleInput('up');
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/);
    assert.deepEqual(calls.insert, []);
    assert.equal(calls.close, 0);
  });

  test('a query parks the cursor on the first matching row, group or file', async () => {
    const entries = [
      { path: 'src/a.ts', state: 'clean' },
      { path: 'src/b.ts', state: 'clean' },
      { path: 'z.ts', state: 'clean' },
    ];
    const { view } = await open({ entries });
    view.handleInput('ctrl+o'); // tree: S30 opened `src`
    for (const character of 'src') view.handleInput(character);
    assert.equal(selectedName(rowsOf(view)), 'src', 'a query parks the cursor on the first row it lists');
    // S10 stands: the query holds every group open, so the fold key changes nothing.
    const during = rowsOf(view);
    view.handleInput('space');
    assert.deepEqual(rowsOf(view), during, 'the query holds the folder open');
    view.handleInput('ctrl+u');
    assert.equal(selectedName(rowsOf(view)), 'src', 'and clearing it keeps the first row, the group');
  });

  test('space folds the group holding the focused file and parks the cursor on its row', async () => {
    const entries = [{ path: 'src/a.ts', state: 'clean' }, { path: 'src/b.ts', state: 'clean' }];
    const { view, calls } = await open({ entries });
    view.handleInput('ctrl+o'); // tree: [src] a.ts b.ts
    assert.equal(selectedName(rowsOf(view)), 'a.ts');
    view.handleInput('space'); // folds `src`, the folder holding a.ts
    let rows = rowsOf(view);
    assert.ok(!bodyText(rows).includes('a.ts'), 'the only group is folded, so no file row is left');
    assert.equal(selectedName(rows), 'src', 'S38: the cursor rests on the group row that held the file');
    // A group row is still not a file: nothing marks, opens or inserts it.
    view.handleInput('tab');
    assert.ok(!bodyText(rowsOf(view)).includes(SELECTION_MARK), 'a group row is never marked');
    view.handleInput('ctrl+e');
    assert.deepEqual(calls.open, [], 'a group row is never opened');
    assert.equal(calls.close, 0);
    view.handleInput('space');
    rows = rowsOf(view);
    assert.equal(selectedName(rows), 'src', 'space reopened the tree and the cursor stays on the folder row');
    assert.ok(bodyText(rows).includes('a.ts'), 'the files paint again');
    view.handleInput('down');
    assert.equal(selectedName(rowsOf(view)), 'a.ts', 'and one step down reaches the first file');
    // S43 supersedes S10's "enter also folds": the fold keys are space, shift+space
    // and the click, so enter on this group row changes nothing and stays open.
    view.handleInput('up');
    view.handleInput('enter');
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('a.ts'), 'enter leaves the folder under the cursor open');
    assert.equal(selectedName(rows), 'src', 'and the group row keeps the cursor');
    assert.deepEqual(calls.insert, [], 'a group row never inserts');
    assert.equal(calls.close, 0, 'and the panel stays open');
  });
});

describe('the tree orders fold by default with a chevron (S29)', () => {
  test('a chosen tree paints every group collapsed, with the collapsed chevron', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o'); // tree, with the root file brand-new.ts highlighted
    let rows = rowsOf(view);
    assert.deepEqual(groupCells(rows), [' ▸ src'], 'the folder is collapsed, and its chevron paints');
    assert.ok(!bodyText(rows).includes('util.ts'), 'nothing below the folded folder paints');
    // S30 also holds here: the highlighted file has no folder to open, so the tree
    // paints no file row for it at all beyond the repository root.
    view.handleInput('ctrl+o'); // ext
    rows = rowsOf(view);
    assert.deepEqual(groupCells(rows), [' ▸ .md', ' ▾ .ts'], 'only the highlighted file extension is open');
    assert.ok(bodyText(rows).includes('cursor.ts'), 'the ts group paints its files');
    assert.ok(!bodyText(rows).includes('README.md'), 'the md group stays collapsed');
  });

  test('an open group paints the expanded chevron, and the names keep their column', async () => {
    const { view } = await open();
    for (let step = 0; step < 3; step += 1) view.handleInput('down'); // src/lib/util.ts
    view.handleInput('ctrl+o'); // tree: src and src/lib open (S30)
    const cells = bodyCells(rowsOf(view));
    assert.deepEqual(groupCells(rowsOf(view)), [' ▾ src', ' ▾   lib']);
    // The chevron lives in the marker column, so a name starts three cells in (plus
    // one indent level per depth) on a group row AND on a file row.
    assert.equal(cells[0].indexOf('src'), 3);
    assert.equal(cells[1].indexOf('lib'), 5);
    assert.equal(cells[2].indexOf('util.ts'), 7);
    assert.equal(cells[3].indexOf('cursor.ts'), 5);
    assert.equal(cells[4].indexOf('README.md'), 3);
    assert.equal(cells[5].indexOf('brand-new.ts'), 3);
  });

  test('the cursor mark stays readable next to the chevron on a group row', async () => {
    // S38: the cursor rests on the group row it folded, where the marker column holds
    // both glyphs.
    const entries = [{ path: 'src/a.ts', state: 'clean' }];
    const { view } = await open({ entries });
    view.handleInput('ctrl+o'); // tree: [src] a.ts
    view.handleInput('space'); // folds `src`, the folder holding the file
    const cells = bodyCells(rowsOf(view));
    assert.equal(cells[0], '▸▸ src', 'the cursor mark and the collapsed chevron share the three-cell marker column');
    assert.equal(listLine(rowsOf(view)[BODY_TOP]).length, listWidth(rowsOf(view)), 'the row keeps the pane width');
  });

  test('paint and hit-testing still read one geometry with the chevrons in place', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o'); // tree, every group collapsed
    rowsOf(view); // the host paints, which is what the hit map is built from
    // The first body row is the `src` group row; a click on it opens it.
    assert.deepEqual(view.handleMouse(mouse({ y: BODY_TOP })), { handled: true, render: true });
    assert.ok(bodyText(rowsOf(view)).includes('cursor.ts'), 'the click landed on the row it looks like');
  });
});

describe('only the focused file path opens on an order change (S30)', () => {
  test('tree opens the folders holding the highlighted file and collapses the rest', async () => {
    const { view } = await open({ entries: NESTED });
    view.handleInput('down');
    view.handleInput('down'); // src/web/test.ts
    assert.equal(selectedName(rowsOf(view)), 'test.ts');
    view.handleInput('ctrl+o'); // tree
    const rows = rowsOf(view);
    assert.deepEqual(groupCells(rows), [' ▾ src', ' ▾   web', ' ▸ web'],
      'src and src/web are the only folders open, and the other `web` stays collapsed');
    assert.ok(bodyText(rows).includes('index.ts'), 'the folder holding the file paints its own files');
    assert.ok(!bodyText(rows).includes('app.ts'), 'a group the file is not in stays collapsed');
    assert.equal(selectedName(rows), 'test.ts', 'the highlight follows the same file');
  });

  test('ext opens only the highlighted file extension group', async () => {
    const { view } = await open({ entries: NESTED });
    view.handleInput('down');
    view.handleInput('down'); // src/web/test.ts
    view.handleInput('ctrl+o'); // tree
    view.handleInput('ctrl+o'); // ext
    const rows = rowsOf(view);
    assert.deepEqual(groupCells(rows), [' ▸ .md', ' ▾ .ts'], 'only the `ts` group is open');
    assert.ok(bodyText(rows).includes('app.ts'), 'every ts file paints inside it');
    assert.ok(!bodyText(rows).includes('README.md'), 'the md group stays collapsed');
    assert.equal(selectedName(rows), 'test.ts');
  });

  test('a repository-root file opens no folder in tree', async () => {
    const { view } = await open({ entries: NESTED });
    view.handleInput('home'); // README.md, at the repository root
    assert.equal(selectedName(rowsOf(view)), 'README.md');
    view.handleInput('ctrl+o'); // tree
    const rows = rowsOf(view);
    assert.deepEqual(groupCells(rows), [' ▸ src', ' ▸ web'], 'every folder stays collapsed');
    assert.equal(selectedName(rows), 'README.md', 'the root file still paints, and keeps the cursor');
  });

  test('moving the highlight leaves the fold state the reader has', async () => {
    const { view } = await open({ entries: NESTED });
    view.handleInput('down');
    view.handleInput('down'); // src/web/test.ts
    view.handleInput('ctrl+o'); // tree: src and src/web open, the other `web` collapsed
    view.handleInput('down'); // src/index.ts
    view.handleInput('down'); // S38: the next row is the collapsed `web` group
    const rows = rowsOf(view);
    assert.equal(selectedName(rows), 'web');
    assert.ok(bodyText(rows).includes('index.ts'), 'the folder the reader had open stays open');
    assert.ok(!bodyText(rows).includes('app.ts'), 'a group the highlight moved past never opens by itself');
  });

  test('choosing an order again re-seeds it, instead of the old per-order memory', async () => {
    const { view } = await open({ entries: NESTED });
    view.handleInput('down');
    view.handleInput('down'); // src/web/test.ts
    view.handleInput('ctrl+o'); // tree
    view.handleInput('shift+space'); // S39: collapses every group
    view.handleInput('shift+space'); // and the second press expands them all
    assert.ok(bodyText(rowsOf(view)).includes('app.ts'), 'every group is open');
    view.handleInput('home');
    view.handleInput('down');
    view.handleInput('down'); // back onto src/web/test.ts
    assert.equal(selectedName(rowsOf(view)), 'test.ts');
    view.handleInput('ctrl+o'); // ext
    view.handleInput('ctrl+o'); // files
    view.handleInput('ctrl+o'); // tree again
    const rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('test.ts'), 'the focused file path is open');
    assert.ok(!bodyText(rows).includes('app.ts'), 'S30 supersedes S10: the tree re-seeds, it does not remember');
  });
});

describe('group rows read in the grey role (S31)', () => {
  test('a folder row paints in dim, never the file row text tone', async () => {
    const theme = recordingTheme();
    const { view } = await open({ theme });
    view.handleInput('ctrl+o'); // tree, every group collapsed and the cursor on a file
    view.render(WIDTH);
    assert.ok(theme.calls.some((call) => call.role === 'dim' && call.text === 'src'), 'the folder name is dim');
    assert.ok(!theme.calls.some((call) => call.role === 'text' && call.text === 'src'), 'never the file text tone');
    assert.ok(theme.calls.some((call) => call.role === 'text' && call.text === 'README.md'), 'a file name keeps the text tone');
  });

  test('a focused group row keeps the grey label inside the focus band', async () => {
    const theme = recordingTheme();
    const entries = [{ path: 'src/a.ts', state: 'clean' }];
    const { view } = await open({ theme, entries });
    view.handleInput('ctrl+o'); // tree: [src] a.ts
    view.handleInput('space'); // folds src; the cursor rests on the group row
    theme.calls.length = 0;
    view.render(WIDTH);
    assert.ok(theme.calls.some((call) => call.role === 'dim' && call.text === 'src'), 'the focused folder is still grey');
    assert.ok(
      theme.calls.some((call) => call.role === 'bg:selectedBg' && call.text.includes('\x1b[2msrc')),
      'and the focus band is wrapped around that grey label',
    );
  });

  test('the chevron, the marker and the row width are unchanged', async () => {
    const theme = recordingTheme();
    const { view } = await open({ theme });
    view.handleInput('ctrl+o');
    const rows = rowsOf(view);
    assert.equal(listLine(rows[BODY_TOP]).length, listWidth(rows), 'the group row keeps the pane width');
    assert.ok(!theme.calls.some((call) => call.text === '\u25be' || call.text === '\u25b8'), 'the chevron and the marker stay unpainted');
  });
});

describe('space folds only where the order paints groups (S32)', () => {
  test('in the flat files order space does nothing at all', async () => {
    const { view, calls } = await open();
    const before = rowsOf(view);
    const renders = calls.render;
    view.handleInput('space');
    assert.deepEqual(rowsOf(view), before, 'no fold, no cursor move and no query character');
    assert.equal(calls.render, renders, 'nothing changed, so nothing repaints');
  });

  test('the footer names the fold keys only while the order paints groups', async () => {
    const { view } = await open();
    for (const [order, action] of [
      ['files', undefined],
      ['tree', 'shift+space expand all'],
      ['ext', 'shift+space collapse all'],
      ['files', undefined],
    ]) {
      const footer = footerOf(rowsOf(view, 200));
      if (action === undefined) {
        assert.ok(!footer.includes('space') && !footer.includes('fold'), `the ${order} footer names no fold key: ${footer}`);
      } else {
        assert.ok(footer.includes('space fold'), `the ${order} footer names space fold: ${footer}`);
        assert.ok(footer.includes(action), `the ${order} footer names ${action}: ${footer}`);
      }
      view.handleInput('ctrl+o');
    }
  });
});

describe('shift+space is one toggle over every group (S39)', () => {
  test('it collapses EVERY group, the ones holding the focused file included, and parks the cursor on the group that held it', async () => {
    const { view, calls } = await open({ entries: NESTED });
    view.handleInput('down');
    view.handleInput('down'); // src/web/test.ts
    view.handleInput('ctrl+o'); // tree: src and src/web open, the other `web` collapsed
    assert.equal(selectedName(rowsOf(view)), 'test.ts');
    view.handleInput('shift+space');
    let rows = rowsOf(view);
    assert.ok(!bodyText(rows).includes('test.ts'), 'the folders holding the focused file collapse too');
    assert.ok(!bodyText(rows).includes('app.ts'), 'and so does every other group');
    assert.deepEqual(groupCells(rows), ['▸▸ src', ' ▸ web'], 'every group row paints collapsed, and the cursor rests on src');
    // S39: the group that held the file keeps the cursor. In a nested tree the
    // deepest holder (`src/web`) is hidden by its own collapse, so the cursor rests
    // on the nearest group row above it that still paints — `src`.
    assert.equal(selectedName(rows), 'src', 'the cursor rests on the group row that held the file');
    assert.deepEqual(calls.insert, []);
    assert.equal(calls.close, 0);
    // The same key now expands every group, and the cursor stays on its row.
    view.handleInput('shift+space');
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('app.ts'), 'every group is open again');
    assert.ok(bodyText(rows).includes('test.ts'));
    assert.equal(selectedName(rows), 'src', 'the group row under the cursor stays the one the file came from');
  });

  test('a cursor already on a group row keeps that row across both directions', async () => {
    const entries = [{ path: 'src/a.ts', state: 'clean' }, { path: 'src/b.ts', state: 'clean' }];
    const { view } = await open({ entries });
    view.handleInput('ctrl+o'); // tree: src open, a.ts b.ts
    view.handleInput('home'); // the src group row
    view.handleInput('shift+space');
    let rows = rowsOf(view);
    assert.equal(selectedName(rows), 'src', 'the focused group row keeps the cursor');
    assert.ok(!bodyText(rows).includes('a.ts'), 'and every group is collapsed');
    view.handleInput('shift+space');
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('a.ts'), 'the second press expands every group');
    assert.equal(selectedName(rows), 'src', 'with the cursor still on its row');
  });

  test('a repository-root file has no group to park on, so the cursor keeps its own row', async () => {
    const entries = [{ path: 'src/a.ts', state: 'clean' }, { path: 'README.md', state: 'clean' }];
    const { view } = await open({ entries });
    view.handleInput('ctrl+o'); // tree with the root file focused: every group collapsed
    assert.equal(selectedName(rowsOf(view)), 'README.md');
    view.handleInput('shift+space'); // every group is collapsed, so this expands them
    const rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('a.ts'), 'every group opened');
    assert.equal(selectedName(rows), 'README.md', 'the row the reader was on stays under the cursor');
  });

  test('in ext it collapses the focused extension group too and parks on it', async () => {
    const { view } = await open({ entries: NESTED });
    view.handleInput('down');
    view.handleInput('down'); // src/web/test.ts
    view.handleInput('ctrl+o'); // tree
    view.handleInput('ctrl+o'); // ext: only .ts open
    assert.equal(selectedName(rowsOf(view)), 'test.ts');
    view.handleInput('shift+space');
    let rows = rowsOf(view);
    assert.ok(!bodyText(rows).includes('test.ts'), 'the focused extension group collapses too');
    assert.equal(selectedName(rows), '.ts', 'the cursor rests on the extension group that held the file');
    view.handleInput('shift+space');
    rows = rowsOf(view);
    assert.ok(bodyText(rows).includes('README.md'), 'every extension group opens again');
    assert.equal(selectedName(rows), '.ts', 'with the cursor still on that group row');
  });

  test('in the flat files order it does nothing', async () => {
    const { view, calls } = await open();
    const before = rowsOf(view);
    const renders = calls.render;
    view.handleInput('shift+space');
    assert.deepEqual(rowsOf(view), before);
    assert.equal(calls.render, renders);
  });

  test('the host delivers shift+space as a CSI-u or modifyOtherKeys sequence', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    // Kitty keyboard protocol: codepoint 32 (space) with modifier 2 = shift.
    assert.equal(tui.matchesKey('\x1b[32;2u', 'shift+space'), true);
    // xterm modifyOtherKeys when the Kitty protocol is not enabled.
    assert.equal(tui.matchesKey('\x1b[27;2;32~', 'shift+space'), true);
    // A legacy terminal cannot tell it from a plain space, which stays the fold key.
    assert.equal(tui.matchesKey(' ', 'shift+space'), false);
    assert.equal(tui.matchesKey(' ', 'space'), true);

    const { view } = await open({ entries: NESTED, helpers: { ...helpers, matchesKey: tui.matchesKey } });
    view.handleInput('\x1b[B');
    view.handleInput('\x1b[B'); // raw down arrow to src/web/test.ts
    view.handleInput('\x0f'); // raw ctrl+o
    assert.ok(!bodyText(rowsOf(view)).includes('app.ts'));
    view.handleInput('\x1b[32;2u');
    assert.ok(!bodyText(rowsOf(view)).includes('app.ts'), 'the kitty sequence reaches the fold-all key');
    view.handleInput('\x1b[27;2;32~');
    assert.ok(bodyText(rowsOf(view)).includes('app.ts'), 'so does the modifyOtherKeys one');
  });
});

describe('the fold-all legend states the action it performs (S40)', () => {
  test('it names expand all while every group is collapsed, and collapse all otherwise', async () => {
    const { view } = await open({ entries: NESTED });
    // The flat order names neither fold key (S32 stands).
    let footer = footerOf(rowsOf(view, 200));
    assert.ok(!footer.includes('space') && !footer.includes('fold'), `the flat footer names no fold key: ${footer}`);

    view.handleInput('ctrl+o'); // tree, with a root file focused: every group is collapsed
    footer = footerOf(rowsOf(view, 200));
    assert.ok(footer.includes('space fold'), footer);
    assert.ok(footer.includes('shift+space expand all'), footer);
    assert.ok(!footer.includes('collapse all'), footer);

    view.handleInput('shift+space');
    footer = footerOf(rowsOf(view, 200));
    assert.ok(footer.includes('shift+space collapse all'), footer);
    assert.ok(!footer.includes('expand all'), footer);

    // A hand-folded group makes the tree mixed, so the legend says it would collapse.
    view.handleInput('home');
    view.handleInput('space'); // folds `src` from its own row
    footer = footerOf(rowsOf(view, 200));
    assert.ok(footer.includes('shift+space collapse all'), `a mixed tree would collapse: ${footer}`);

    // ext paints the same two states.
    view.handleInput('ctrl+o'); // ext, every group collapsed (the cursor came from a group row)
    footer = footerOf(rowsOf(view, 200));
    assert.ok(footer.includes('shift+space expand all'), `ext starts collapsed: ${footer}`);
    view.handleInput('shift+space');
    footer = footerOf(rowsOf(view, 200));
    assert.ok(footer.includes('shift+space collapse all'), `ext now shows the other action: ${footer}`);

    // And the flat order drops both tokens again.
    view.handleInput('ctrl+o');
    footer = footerOf(rowsOf(view, 200));
    assert.ok(!footer.includes('space') && !footer.includes('fold'), `the flat footer names no fold key: ${footer}`);
  });

  test('a query holds every group open, so the legend offers to collapse them', async () => {
    const { view } = await open({ entries: NESTED });
    view.handleInput('ctrl+o'); // tree, every group collapsed
    for (const character of 'app') view.handleInput(character);
    const footer = footerOf(rowsOf(view, 200));
    assert.ok(footer.includes('shift+space collapse all'), footer);
  });
});

describe('the body geometry (S25)', () => {
  test('the preview box rides the info row, closes on the list last row and a rule closes the body', async () => {
    const { view } = await open();
    const rows = rowsOf(view);
    assert.equal(rows.length, CARD_HEIGHT, 'the card keeps its height budget');
    const top = previewTop(rows);
    assert.ok(top.startsWith('╭'), top);
    assert.ok(top.endsWith('1/2╮'), `the position rides the box top on the info row: ${top}`);
    assert.match(previewPane(rows, BODY_ROWS - 1), /^╰─+╯$/, 'the box closes on the list last body row');
    assert.equal(listWidth(rows), paneWidths().list, 'the list keeps its share');
    assert.ok(helpers.visibleWidth(previewTop(rows)) === paneWidths().preview, 'the box keeps the preview width');
    assert.equal(strip(rows[RULE_ROW]), `│ ${'─'.repeat(WIDTH - 4)} │`, 'one rule closes the body under both columns');
    assert.ok(footerOf(rows).includes('esc'), 'the footer follows the rule');
    assert.equal(RULE_ROW + 2, rows.length - 1, 'the rule, the footer and the bottom rule are the last three rows');
    // The boxed pane keeps `bodyRows - 1` content rows.
    assert.match(previewPane(rows, 0), /^│1 preview of brand-new\.ts/, 'the first content row is the file first line');
    assert.match(previewPane(rows, BODY_ROWS - 2), /^│ +│$/, 'the last content row is an empty row inside the box');
    for (const row of rows) assert.equal(helpers.visibleWidth(row), WIDTH, 'every row still one terminal line');
    // Painting and hit-testing read one geometry: the click lands on the row it sees.
    const target = rowOf(rows, 'README.md');
    assert.deepEqual(view.handleMouse(mouse({ y: target })), { handled: true, render: true });
    assert.equal(selectedName(rowsOf(view)), 'README.md');
  });

  test('the unboxed fallback fills the same rows on a body too short for a box', async () => {
    const { view } = await open({ rowsAvailable: 9 });
    const rows = rowsOf(view);
    assert.equal(rows.length, 7, 'the card keeps its height budget');
    const top = previewTop(rows);
    assert.ok(!top.includes('╭'), `no box at this height: ${top}`);
    assert.ok(top.trimEnd().endsWith('1/2'), `the position still rides the info row: ${top}`);
    assert.match(previewPane(rows, 0), /^1 preview of brand-new\.ts/, 'the one content row is the file first line');
    assert.ok(!previewPane(rows, 0).includes('╭'));
    const bodyRows = rows.length - 6;
    assert.equal(strip(rows[BODY_TOP + bodyRows]).startsWith('│ ─'), true, 'the rule still closes the body');
  });

  test('the info row counts as part of the preview for the wheel and the click', async () => {
    const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const { view } = await open({ loadPreview: async () => preview(long) });
    const rows = rowsOf(view);
    const previewX = previewStart(rows) + 2;
    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: previewX, y: INFO_ROW })),
      { handled: true, render: true },
      'the wheel over the box top scrolls the preview',
    );
    assert.match(previewPane(rowsOf(view), 0), /^│ 2 line 1/);
    assert.deepEqual(
      view.handleMouse(mouse({ x: previewX, y: INFO_ROW })),
      { handled: true, render: false },
      'a click on the box top is absorbed and moves nothing',
    );
    assert.match(previewPane(rowsOf(view), 0), /^│ 2 line 1/);
  });
});

describe('the Tab mark bar (S26)', () => {
  test('a marked row paints its bar in a theme role whether it is focused or idle', async () => {
    const theme = recordingTheme();
    const { view } = await open({ theme });
    view.handleInput('tab'); // the highlighted row is marked AND focused
    let rows = rowsOf(view);
    const focused = view.render(WIDTH)[rowOf(rows, 'brand-new.ts')];
    assert.ok(strip(focused).includes(CURSOR_MARK), 'the marked row is the focused one');
    assert.notEqual(sgrAt(focused, SELECTION_MARK), '', 'the focused marked row paints its bar');
    view.handleInput('down'); // the marked row is idle now
    rows = rowsOf(view);
    const idle = view.render(WIDTH)[rowOf(rows, 'brand-new.ts')];
    assert.ok(!strip(idle).includes(CURSOR_MARK), 'the marked row is no longer focused');
    assert.ok(strip(idle).includes(SELECTION_MARK), 'its bar is still painted');
    assert.notEqual(sgrAt(idle, SELECTION_MARK), '', 'the idle marked row paints its bar too');
    assert.ok(
      theme.calls.some((call) => call.role === 'accent' && call.text === SELECTION_MARK),
      'the idle bar carries the theme key role, never an unstyled cell',
    );
    assert.equal(listCell(rows, 'brand-new.ts').indexOf('brand-new.ts'), 3, 'the marker column never moves');
  });

  test('an unmarked row paints no bar and keeps the marker column', async () => {
    const theme = recordingTheme();
    const { view } = await open({ theme });
    view.handleInput('down');
    const rows = rowsOf(view);
    assert.ok(!bodyText(rows).includes(SELECTION_MARK), 'nothing is marked');
    assert.equal(listCell(rows, 'README.md').indexOf('README.md'), 3);
    assert.ok(!theme.calls.some((call) => call.text === SELECTION_MARK), 'no bar is painted at all');
  });
});

describe('the preview pane (S11, S12 as composed)', () => {
  test('the preview sits in its own boxed pane with a gutter and its position', async () => {
    const { view } = await open();
    const rows = rowsOf(view);
    const top = previewTop(rows);
    assert.ok(top.startsWith('╭'), top);
    assert.ok(top.endsWith('1/2╮'), top);
    assert.match(previewPane(rows, 0), /^│1 preview of brand-new\.ts/, 'the gutter numbers the first line');
    assert.match(previewPane(rows, 1), /^│2 second line/);
    assert.match(previewPane(rows, BODY_ROWS - 1), /^╰─+╯$/, 'the box closes on the list last body row (S25)');
    for (const row of rows) assert.equal(helpers.visibleWidth(row), WIDTH, 'the box never makes a row ragged');
  });

  test('a pending preview paints its own notice and lands without a second read', async () => {
    let reads = 0;
    const mounted = mount({ loadPreview: async () => { reads += 1; return preview(['landed']); } });
    mounted.view.render(WIDTH);
    await tick();
    mounted.view.render(WIDTH);
    assert.ok(bodyText(rowsOf(mounted.view)).includes('Loading preview'), 'the pending read asks for nothing it does not have');
    await tick();
    const rows = rowsOf(mounted.view);
    assert.ok(bodyText(rows).includes('landed'));
    assert.equal(reads, 1, 'one read per highlighted file');
    mounted.view.render(WIDTH);
    mounted.view.render(WIDTH);
    assert.equal(reads, 1);
  });

  test('the highlighter runs once per preview, never per repaint', async () => {
    let paints = 0;
    const { view } = await open({
      highlight: (code) => {
        paints += 1;
        return code.split('\n').map((line) => `\x1b[33m${line}\x1b[39m`);
      },
      languageForPath: () => 'ts',
    });
    assert.equal(paints, 1, 'the preview is highlighted once when it lands');
    view.render(WIDTH);
    view.render(WIDTH);
    view.handleInput('tab');
    assert.equal(paints, 1, 'a repaint never pays for the highlighter again');
  });

  test('a binary preview and a failed read paint their own sentences', async () => {
    const binary = await open({ loadPreview: async () => ({ kind: 'binary', message: 'Binary file \u2014 preview not available.' }) });
    assert.ok(bodyText(rowsOf(binary.view)).includes('Binary file'), 'the binary notice is painted as it is');
    assert.ok(!bodyText(rowsOf(binary.view)).includes('/2'), 'a binary preview claims no line position');

    const failed = await open({ loadPreview: async () => { throw new Error('denied'); } });
    assert.ok(bodyText(rowsOf(failed.view)).includes('Cannot read brand-new.ts: denied.'), bodyText(rowsOf(failed.view)));
    assert.equal(failed.calls.close, 0, 'a failed preview never closes the panel');
  });
});

describe('degradations (S1, S15)', () => {
  test('a hostile theme and an absent theme still paint every row at the requested width', async () => {
    const hostile = {
      fg() { throw new Error('no colour'); },
      bold() { throw new Error('no bold'); },
      bg() { throw new Error('no band'); },
    };
    const painted = await open({ theme: hostile });
    const rows = rowsOf(painted.view);
    assert.equal(rows.length, CARD_HEIGHT);
    for (const row of rows) assert.equal(helpers.visibleWidth(row), WIDTH);
    assert.ok(rows[BODY_TOP].includes('brand-new.ts'));

    const absent = await open({ theme: null });
    assert.ok(rowsOf(absent.view)[BODY_TOP].includes('brand-new.ts'));
    assert.ok(footerOf(rowsOf(absent.view)).includes('esc'));
  });

  test('an unwritable terminal sequence in the scope path never reaches the frame', async () => {
    const { view } = await open({ scope: { root: '/repo/evil\x1b[31mred\x07/x', kind: 'main', label: 'main' } });
    const top = view.render(WIDTH)[0];
    assert.ok(!top.includes('\x1b'), 'no escape sequence is painted');
    assert.ok(!top.includes('\x07'));
    assert.ok(strip(top).includes('evilred'), strip(top));
    assert.equal(helpers.visibleWidth(top), WIDTH);
  });

  test('a missing listing reader and a missing preview reader keep the panel alive', async () => {
    const noListing = createFilesPickerView({
      theme: plainTheme,
      helpers,
      rowsAvailable: ROWS_AVAILABLE,
      loadEntries: null,
      loadPreview: async () => preview(['x']),
    });
    await tick();
    assert.ok(bodyText(rowsOf(noListing)).includes('no listing reader'));

    const noPreview = await open({ loadPreview: null });
    assert.ok(bodyText(rowsOf(noPreview.view)).includes('Cannot read brand-new.ts: no preview reader was supplied.'));
    assert.equal(noPreview.calls.close, 0);
  });
});

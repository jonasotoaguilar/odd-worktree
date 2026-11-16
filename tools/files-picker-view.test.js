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

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createFilesPickerView } = require('../lib/files-picker-view.js');

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const WIDTH = 120;
// The terminal rows the view is offered; the card takes its share of them (S15).
const ROWS_AVAILABLE = 20;
const CARD_HEIGHT = 17;
// 0-based row of the first body row: the top rule, the search row, one blank row.
const BODY_TOP = 3;
const BLANK_ROW = 2;
const SEARCH_ROW = 1;
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

function selectedRow(rows) {
  const line = rows.find((row) => row.includes('\u25b8'));
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

  test('the listing path sits at the top-right next to esc, and elides from the left when narrow', async () => {
    const { view } = await open();
    const roomy = rowsOf(view)[0];
    assert.ok(roomy.includes(SCOPE.root), roomy);
    assert.ok(roomy.endsWith(`${SCOPE.root} esc ╮`), roomy);

    for (const width of [50, 40]) {
      const row = view.render(width).map(strip)[0];
      assert.equal(helpers.visibleWidth(row), width);
      assert.ok(row.startsWith('╭─ ✿ Files'), row);
      assert.ok(row.includes('\u2026'), `the path is elided at ${width}: ${row}`);
      assert.ok(!row.includes('/home/dev'), 'only the identifying tail survives');
      assert.ok(row.includes(SCOPE.root.slice(-10)), `the tail survives at ${width}: ${row}`);
      assert.ok(row.endsWith('esc ╮'), row);
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
      assert.ok(rows[SEARCH_ROW].includes('› Search'), rows[SEARCH_ROW]);
      assert.ok(footerOf(rows).includes('esc'), `the smallest card still names esc: ${footerOf(rows)}`);
    }
  });

  test('the search row sits under the title, shows its placeholder and then a blank row', async () => {
    const { view } = await open();
    const rows = rowsOf(view);
    assert.ok(rows[SEARCH_ROW].startsWith('│ › Search'), rows[SEARCH_ROW]);
    assert.ok(rows[SEARCH_ROW].endsWith('│'));
    assert.equal(rows[BLANK_ROW], `│${' '.repeat(WIDTH - 2)}│`);
    assert.ok(rows[BODY_TOP].includes('brand-new.ts'), 'the list starts under the blank row');
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
    const footer = footerOf(rowsOf(view, 200));
    for (const token of [
      '↑/↓ move', 'tab select', 'ctrl+j/k scroll', 'ctrl+o order', 'space fold',
      'ctrl+u clear', 'ctrl+e edit', 'enter insert', 'esc close',
    ]) {
      assert.ok(footer.includes(token), `the footer names ${token}: ${footer}`);
    }
    for (const hidden of ['ctrl+k', 'ctrl+shift', 'ctrl+c', 'esc/', 'home', 'end', 'enter/']) {
      assert.ok(!footer.includes(hidden), `the footer never names ${hidden}: ${footer}`);
    }
    assert.ok(footer.endsWith('modified'), footer);
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
    // option per key still fits on one row.
    const compact = rowsOf(view, 80);
    const footer = footerOf(compact);
    for (const keyName of ['↑/↓', 'tab', 'ctrl+o', 'space', 'ctrl+u', 'ctrl+e', 'enter', 'esc']) {
      assert.ok(footer.includes(keyName), `the footer keeps ${keyName}: ${footer}`);
    }
    assert.ok(!footer.includes(' move'), `the words give way first: ${footer}`);
    assert.ok(!footer.includes('ctrl+j/k'), `the preview scroll gives way first, the least important key: ${footer}`);
    assert.equal(compact.length, CARD_HEIGHT, 'the footer never adds a row');
    for (const row of compact) assert.equal(helpers.visibleWidth(row), 80);

    // Narrower still: only the highest-priority keys survive, on the same row.
    const tiny = rowsOf(view, 40);
    const dropped = footerOf(tiny);
    assert.ok(dropped.includes('esc'), `esc never gives way: ${dropped}`);
    assert.ok(!dropped.includes('ctrl+j/k') && !dropped.includes('ctrl+u'), `the least important keys give way: ${dropped}`);
    assert.equal(tiny.length, CARD_HEIGHT);
    for (const row of tiny) assert.equal(helpers.visibleWidth(row), 40);
  });

  test('the active order is always visible and follows ctrl+o', async () => {
    const { view } = await open();
    assert.ok(footerOf(rowsOf(view)).endsWith('modified'));
    view.handleInput('ctrl+o');
    assert.ok(footerOf(rowsOf(view)).endsWith('path'));
    view.handleInput('ctrl+o');
    assert.ok(footerOf(rowsOf(view)).endsWith('ext'));
    view.handleInput('ctrl+o');
    assert.ok(footerOf(rowsOf(view)).endsWith('modified'));
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

  test('the path order paints no trailing directory, because the tree already places it', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o');
    const rows = rowsOf(view);
    assert.ok(!listCell(rows, 'util.ts').includes('src/lib'), listCell(rows, 'util.ts'));
    const painted = rows
      .slice(BODY_TOP, rows.length - 2)
      .map((row) => (row.split(' │ ')[0] || '').replace(/^│ /, '').trim());
    assert.ok(painted.includes('src'), 'the folder group paints its own row');
    assert.ok(painted.includes('lib'), 'the nested folder paints its own row');
    assert.ok(painted.indexOf('src') < painted.findIndex((cell) => cell.endsWith('util.ts')), 'the tree places the file under its folder');
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
    assert.match(previewPane(rowsOf(view), 1), /^│ 1 line 0/, 'the box starts at line 1');
    view.handleInput('ctrl+j');
    assert.match(previewPane(rowsOf(view), 1), /^│ 2 line 1/, 'ctrl+j scrolls one row');
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/, 'a scroll never moves the selection');
    view.handleInput('ctrl+k');
    assert.match(previewPane(rowsOf(view), 1), /^│ 1 line 0/);
    view.handleInput('ctrl+shift+j');
    assert.match(previewPane(rowsOf(view), 1), /^│ 2 line 1/, 'the ctrl+shift form scrolls too');
    view.handleInput('ctrl+shift+k');
    assert.match(previewPane(rowsOf(view), 1), /^│ 1 line 0/);
    for (let step = 0; step < 200; step += 1) view.handleInput('ctrl+j');
    const clamped = rowsOf(view);
    assert.match(previewPane(clamped, 1), /^│51 line 50/, 'scrolling stops at the last full page');
    assert.ok(bodyText(clamped).includes('line 59'), 'the last line is painted on that page');
    const renders = calls.render;
    view.handleInput('ctrl+j');
    assert.equal(calls.render, renders, 'a clamped scroll repaints nothing');
    assert.deepEqual(calls.insert, []);
  });

  test('home/end reach the first and last FILE row and never a group row', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o');
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/);
    view.handleInput('home');
    assert.match(selectedRow(rowsOf(view)), /util\.ts/, 'the first file row, not the src group');
    view.handleInput('end');
    assert.match(selectedRow(rowsOf(view)), /brand-new\.ts/, 'the last file row');
  });

  test('ctrl+home and ctrl+end reach the preview edges', async () => {
    const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const { view } = await open({ loadPreview: async () => preview(long) });
    for (let step = 0; step < 5; step += 1) view.handleInput('ctrl+j');
    assert.match(previewPane(rowsOf(view), 1), /^│ 6 line 5/);
    view.handleInput('ctrl+home');
    assert.match(previewPane(rowsOf(view), 1), /^│ 1 line 0/);
    view.handleInput('ctrl+end');
    assert.match(previewPane(rowsOf(view), 1), /^│51 line 50/, 'ctrl+end lands on the last page');
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

  test('enter and space fold the focused group, and the fold state is kept per order', async () => {
    const { view, calls } = await open();
    view.handleInput('ctrl+o'); // path
    let rows = rowsOf(view);
    // The first body row is the `src` group: click it, so the fold keys have a group.
    view.handleMouse(mouse({ y: BODY_TOP }));
    assert.ok(bodyText(rows).includes('util.ts'), 'every group starts expanded');
    view.handleInput('space');
    rows = rowsOf(view);
    assert.ok(!bodyText(rows).includes('util.ts'), 'space folds the focused group');
    assert.ok(!bodyText(rows).includes('cursor.ts'));
    assert.ok(bodyText(rows).includes('src'), 'the group row stays');
    view.handleInput('space');
    assert.ok(bodyText(rowsOf(view)).includes('util.ts'), 'space unfolds it again');
    view.handleInput('enter');
    assert.ok(!bodyText(rowsOf(view)).includes('util.ts'), 'enter folds the same row');
    assert.deepEqual(calls.insert, [], 'a group row never inserts');
    assert.equal(calls.close, 0);

    view.handleInput('ctrl+o'); // ext: its own fold set starts empty
    assert.ok(bodyText(rowsOf(view)).includes('.md'), 'the ext order paints its own groups');
    view.handleInput('ctrl+o'); // modified
    view.handleInput('ctrl+o'); // path again
    assert.ok(!bodyText(rowsOf(view)).includes('util.ts'), 'the path order kept its fold');
  });

  test('a non-empty query forces every group open and makes the fold keys inert', async () => {
    const { view } = await open();
    view.handleInput('ctrl+o');
    rowsOf(view);
    view.handleMouse(mouse({ y: BODY_TOP })); // the `src` group row
    view.handleInput('space');
    assert.ok(!bodyText(rowsOf(view)).includes('util.ts'));
    for (const character of 'util') view.handleInput(character);
    assert.ok(bodyText(rowsOf(view)).includes('util.ts'), 'a match is never hidden behind a fold');
    view.handleInput('space');
    assert.ok(bodyText(rowsOf(view)).includes('util.ts'), 'the fold keys do nothing while a query is active');
  });

  test('ctrl+o keeps the same file highlighted and repaints the order', async () => {
    const { view } = await open();
    view.handleInput('down');
    view.handleInput('ctrl+o');
    assert.match(selectedRow(rowsOf(view)), /cursor\.ts/);
    assert.ok(footerOf(rowsOf(view)).endsWith('path'));
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
    assert.match(previewPane(rows, 1), /^│ 6 line 5/);

    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, y: BODY_TOP })),
      { handled: true, render: false },
      'a one-file list has nowhere to move',
    );
    rows = rowsOf(view);
    assert.match(previewPane(rows, 1), /^│ 6 line 5/, 'the list wheel never scrolls the preview');

    const previewX = previewStart(rows) + 2;
    assert.deepEqual(
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: previewX, y: BODY_TOP })),
      { handled: true, render: true },
    );
    rows = rowsOf(view);
    assert.match(previewPane(rows, 1), /^│ 7 line 6/, 'the preview wheel scrolls the preview');
    assert.match(selectedRow(rows), /a\.ts/, 'and never moves the selection');

    for (let step = 0; step < 200; step += 1) {
      view.handleMouse(mouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: previewX, y: BODY_TOP }));
    }
    rows = rowsOf(view);
    assert.match(previewPane(rows, 1), /^│51 line 50/);
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

describe('the preview pane (S11, S12 as composed)', () => {
  test('the preview sits in its own boxed pane with a gutter and its position', async () => {
    const { view } = await open();
    const rows = rowsOf(view);
    const top = previewPane(rows, 0);
    assert.ok(top.startsWith('╭'), top);
    assert.ok(top.endsWith('1/2╮'), top);
    assert.match(previewPane(rows, 1), /^│1 preview of brand-new\.ts/, 'the gutter numbers the first line');
    assert.match(previewPane(rows, 2), /^│2 second line/);
    const bodyRows = CARD_HEIGHT - 5;
    assert.match(previewPane(rows, bodyRows - 1), /^╰─+╯$/, 'the box closes on the last body row');
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

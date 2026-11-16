'use strict';
// T3 (files-picker S9) and T10 (S20): `lib/files-scope-view.js` — the worktree
// scope step.
//
// Contract under test, as observable output only: the card frame at the
// requested width, the `main`-first rows with each scope's `±n files` count at
// the right edge, the focused scope's detail line directly above the footer,
// the one-option-per-key legend painted with the key role, the arrow/enter/esc
// keys, the `a` toggle between the registered list and every worktree of the
// clone, the mouse hover/wheel/click routes, and every degradation (no scopes, a
// narrow or short terminal, a hostile theme, a long label).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createFilesScopeView } = require('../lib/files-scope-view.js');

const NOW = 1_700_000_000_000;
const WIDTH = 80;
const HEIGHT = 12;

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// ANSI-aware stand-ins for the host TUI helpers, injected exactly as the view
// takes them: nothing here is imported statically.
const helpers = {
  visibleWidth: (text) => [...strip(text)].length,
  truncateToWidth: (text, width, ellipsis = '…') => {
    const chars = [...String(text)];
    return chars.length > width
      ? `${chars.slice(0, Math.max(0, width - 1)).join('')}${ellipsis}`
      : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
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

function detail(overrides = {}) {
  return {
    changedFiles: 2,
    lastModifiedMs: NOW - 5 * 60_000,
    lastCommitSubject: 'main subject',
    ahead: 1,
    behind: 0,
    comparison: 'origin/main',
    ...overrides,
  };
}

function scope(overrides = {}) {
  return { root: '/repo', label: 'main', kind: 'main', lastModifiedMs: 100, detail: detail(), ...overrides };
}

const WORKTREE = scope({
  root: '/w/feat-x',
  label: 'feat/x · files-picker',
  kind: 'worktree',
  lastModifiedMs: 900,
  detail: detail({
    lastCommitSubject: 'add the scope step',
    changedFiles: 3,
    lastModifiedMs: NOW - 2 * 60_000,
    ahead: 2,
    behind: 1,
    comparison: 'main',
  }),
});

const SCOPES = [WORKTREE, scope()];

// S20: a checkout Git knows but this package did not create, so it is only on the
// `a` list.
const UNREGISTERED = scope({
  root: '/w/loose',
  label: 'loose · other',
  kind: 'worktree',
  lastModifiedMs: 500,
  detail: detail({ lastCommitSubject: 'an unrelated checkout', changedFiles: 1, lastModifiedMs: NOW - 60 * 60_000, ahead: 0, behind: 0, comparison: 'main' }),
});

function mount(options = {}) {
  const selected = [];
  const closes = [];
  let renders = 0;
  const theme = options.theme === undefined ? plainTheme : options.theme;
  const view = createFilesScopeView({
    scopes: options.scopes === undefined ? SCOPES : options.scopes,
    ...(options.allScopes === undefined ? {} : { allScopes: options.allScopes }),
    theme,
    rowsAvailable: options.rowsAvailable === undefined ? HEIGHT : options.rowsAvailable,
    helpers: options.helpers || helpers,
    now: options.now === undefined ? NOW : options.now,
    onSelect: (chosen) => {
      selected.push(chosen);
      if (typeof options.onSelect === 'function') options.onSelect(chosen);
    },
    onClose: () => {
      closes.push(true);
      if (typeof options.onClose === 'function') options.onClose();
    },
    requestRender: () => {
      renders += 1;
      if (typeof options.requestRender === 'function') options.requestRender();
    },
  });
  return { view, theme, selected, closes, renderCount: () => renders };
}

function rowsOf(view, width = WIDTH) {
  return view.render(width).map(strip);
}

// A mouse event local to the last painted card.
function mouse(overrides = {}) {
  return { type: 'move', button: 'none', x: 5, y: 3, width: WIDTH, height: HEIGHT, ...overrides };
}

describe('frame and geometry (S9)', () => {
  test('draws the card frame, title and subtitle at the requested width', () => {
    const { view } = mount();
    const painted = view.render(WIDTH);
    assert.equal(painted.length, HEIGHT);
    for (const row of painted) assert.equal(helpers.visibleWidth(row), WIDTH);
    const rows = painted.map(strip);
    assert.ok(rows[0].startsWith('╭─ ✿ Files · Choose a scope'), rows[0]);
    assert.ok(rows[0].endsWith('╮'));
    assert.ok(rows[rows.length - 1].startsWith('╰'));
    assert.ok(rows[rows.length - 1].endsWith('╯'));
  });

  test('a terminal too narrow or too short paints one fitted line', () => {
    const { view } = mount({ rowsAvailable: 20 });
    const narrow = view.render(10).map(strip);
    assert.equal(narrow.length, 1);
    assert.equal(helpers.visibleWidth(narrow[0]), 10);
    assert.ok(narrow[0].startsWith('Files —'));

    const short = view.render(WIDTH).map(strip);
    assert.equal(mount({ rowsAvailable: 5 }).view.render(WIDTH).length, 1);
    assert.equal(short.length, 20);
  });

  test('the height follows rowsAvailable, including its function form, capped at 24', () => {
    assert.equal(mount({ rowsAvailable: 8 }).view.render(WIDTH).length, 8);
    assert.equal(mount({ rowsAvailable: () => 9 }).view.render(WIDTH).length, 9);
    assert.equal(mount({ rowsAvailable: 40 }).view.render(WIDTH).length, 24);
    assert.deepEqual(mount({ rowsAvailable: () => { throw new Error('no rows'); } }).view.render(WIDTH), []);
  });

  test('an absent rows source paints nothing', () => {
    const view = createFilesScopeView({ scopes: SCOPES, theme: plainTheme, helpers, now: NOW });
    assert.deepEqual(view.render(WIDTH), []);
    assert.deepEqual(view.render(0), []);
  });
});

describe('scope rows (S9)', () => {
  test('main is first and the worktrees follow by recency', () => {
    const { view } = mount({
      rowsAvailable: 14,
      scopes: [
        scope({ root: '/w/new', label: 'newer', kind: 'worktree', lastModifiedMs: 900 }),
        scope({ root: '/w/old', label: 'older', kind: 'worktree', lastModifiedMs: 10 }),
        scope(),
      ],
    });
    const rows = rowsOf(view);
    assert.ok(rows[2].includes('main'), rows[2]);
    assert.ok(rows[3].includes('newer'), rows[3]);
    assert.ok(rows[4].includes('older'), rows[4]);
  });

  test('each row paints its ±n files count at the right edge, singular at one', () => {
    const { view } = mount();
    const rows = rowsOf(view);
    assert.ok(rows[2].endsWith('±2 files │'), rows[2]);
    assert.ok(rows[3].endsWith('±3 files │'), rows[3]);

    const one = mount({ scopes: [scope({ detail: detail({ changedFiles: 1 }) })] });
    assert.ok(rowsOf(one.view)[2].endsWith('±1 file │'));
  });

  test('a scope with no uncommitted files paints no count', () => {
    for (const detailValue of [{ changedFiles: 0 }, {}, undefined]) {
      const { view } = mount({ scopes: [scope({ detail: detailValue })] });
      const row = rowsOf(view)[2];
      assert.ok(!row.includes('±'), row);
      assert.ok(row.endsWith(' │'));
    }
  });

  test('the focused row carries the band and a marker of constant width', () => {
    const theme = recordingTheme();
    const { view } = mount({ theme });
    const rows = rowsOf(view);
    assert.ok(rows[2].includes('▸ main'), rows[2]);
    assert.ok(!rows[3].includes('▸'));
    // Both rows start their label at the same column: the marker never shifts it.
    assert.equal(rows[2].indexOf('main'), rows[3].indexOf('feat/x · files-picker'));
    const band = theme.calls.find((call) => call.role === 'bg:selectedBg');
    assert.ok(band && band.text.includes('main'), 'the focused row is painted as a band');
    assert.ok(theme.calls.some((call) => call.role === 'text' && call.text === 'feat/x · files-picker'));
  });

  test('a long label is clipped with an ellipsis and the count keeps its right edge', () => {
    const long = scope({
      label: 'a-very-long-worktree-branch-name · an-equally-long-directory-name',
      detail: detail({ changedFiles: 12 }),
    });
    const { view } = mount({ scopes: [long] });
    const row = rowsOf(view)[2];
    assert.ok(row.includes('…'), row);
    assert.ok(row.endsWith('±12 files │'), row);
    assert.equal(helpers.visibleWidth(row), WIDTH);
  });

  test('a terminal sequence and control characters in a label never reach the row', () => {
    const { view } = mount({ scopes: [scope({ label: 'evil\x1b[31mred\x07 \x00name' })] });
    const row = view.render(WIDTH)[2];
    assert.ok(!row.includes('\x1b'), 'no escape sequence is painted');
    assert.ok(!row.includes('\x07') && !row.includes('\x00'));
    assert.ok(strip(row).includes('evilred'), strip(row));
    assert.ok(strip(row).includes('name'), strip(row));
  });
});

describe('the focused detail line (S9)', () => {
  test('sits directly above the footer, subject first and then the data', () => {
    const { view } = mount();
    const rows = rowsOf(view);
    const detailRow = rows[rows.length - 3];
    const footer = rows[rows.length - 2];
    assert.equal(detailRow, `│ ${'main subject · ±2 files · 5m · ↑1 origin/main'}${' '.repeat(WIDTH - 4 - 'main subject · ±2 files · 5m · ↑1 origin/main'.length)} │`);
    assert.ok(footer.includes('↑/↓ move'), footer);
  });

  test('it follows the focused scope as the selection moves', () => {
    const { view } = mount();
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('main subject'));
    view.handleInput('down');
    const moved = rowsOf(view);
    assert.ok(moved[HEIGHT - 3].includes('add the scope step · ±3 files · 2m · ↑2 main · ↓1 main'), moved[HEIGHT - 3]);
  });

  test('an absent or empty detail keeps a blank row of the same geometry', () => {
    const { view } = mount({ scopes: [scope({ detail: undefined })] });
    const row = view.render(WIDTH)[HEIGHT - 3];
    assert.equal(strip(row), `│${' '.repeat(WIDTH - 2)}│`);
  });

  test('zero or absent fields are not painted on it', () => {
    const { view } = mount({
      scopes: [scope({ detail: { changedFiles: 0, lastModifiedMs: 0, ahead: 0, behind: 0, comparison: 'main' } })],
    });
    const row = rowsOf(view)[HEIGHT - 3];
    assert.ok(!row.includes('±0'));
    assert.ok(!row.includes('↑0') && !row.includes('↓0'));
    assert.ok(!row.includes('main'));
  });
});

describe('the footer legend (S9)', () => {
  test('names one option per key: move, open, close', () => {
    const { view } = mount();
    const footer = rowsOf(view)[HEIGHT - 2];
    assert.ok(footer.includes('↑/↓ move · enter open · esc close'), footer);
    assert.ok(!footer.includes('ctrl+k') && !footer.includes('ctrl+j'));
    assert.ok(!footer.includes('ctrl+c'));
  });

  test('paints each key in the key role and its description muted', () => {
    const theme = recordingTheme();
    const { view } = mount({ theme });
    view.render(WIDTH);
    for (const [keyText, rest] of [['↑/↓', ' move'], ['enter', ' open'], ['esc', ' close']]) {
      assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === keyText), keyText);
      assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text === rest), rest);
    }
    assert.ok(theme.calls.some((call) => call.role === 'bold' && strip(call.text) === '↑/↓'));
  });
});

describe('the two lists and the `a` key (S20)', () => {
  test('the step opens on the registered rows and the footer names the list `a` switches to', () => {
    const { view } = mount({ scopes: [scope()], allScopes: [scope(), UNREGISTERED] });
    const registered = rowsOf(view);
    assert.ok(registered[2].includes('main'), registered[2]);
    assert.ok(!registered.join('\n').includes('loose · other'), 'the default rows are the registered ones');
    assert.ok(registered[HEIGHT - 2].includes('a all'), registered[HEIGHT - 2]);
    assert.ok(!registered[HEIGHT - 2].includes('a registered'), 'and it names where the key goes, not where it is');

    view.handleInput('a');
    const all = rowsOf(view);
    assert.ok(all.join('\n').includes('loose · other'), 'every worktree of the clone is offered');
    assert.ok(all[2].includes('main'), 'the main checkout stays first');
    assert.ok(all.findIndex((row) => row.includes('loose · other')) > all.findIndex((row) => row.includes('main')),
      'and every worktree follows it');
    assert.ok(all[HEIGHT - 2].includes('a registered'), all[HEIGHT - 2]);
    assert.ok(!all[HEIGHT - 2].includes('a all'), 'the footer names the way back');

    view.handleInput('a');
    assert.ok(!rowsOf(view).join('\n').includes('loose · other'), 'the key switches back');
  });

  test('a scope both lists carry keeps the cursor; one they do not drops it on the first row', () => {
    const toggled = mount({ scopes: [scope(), WORKTREE], allScopes: [scope(), WORKTREE, UNREGISTERED] });
    toggled.view.handleInput('down');
    assert.ok(rowsOf(toggled.view)[3].includes('▸ feat/x · files-picker'), 'the registered worktree is focused');
    toggled.view.handleInput('a');
    assert.ok(rowsOf(toggled.view)[3].includes('▸ feat/x · files-picker'), 'the same root keeps the cursor on the wider list');
    toggled.view.handleInput('a');
    assert.ok(rowsOf(toggled.view)[3].includes('▸ feat/x · files-picker'), 'and on the way back');

    const dropped = mount({ scopes: [scope(), WORKTREE], allScopes: [scope(), WORKTREE, UNREGISTERED] });
    dropped.view.handleInput('a');
    dropped.view.handleInput('down');
    dropped.view.handleInput('down');
    assert.ok(rowsOf(dropped.view)[4].includes('loose · other'), 'the unregistered checkout is focused');
    dropped.view.handleInput('a');
    assert.ok(rowsOf(dropped.view)[2].includes('▸ main'), 'a root the other list does not carry leaves the first row');
  });

  test('the scope answered is the original object of the list on screen', () => {
    const { view, selected } = mount({ scopes: [scope()], allScopes: [scope(), UNREGISTERED] });
    view.handleInput('a');
    view.handleInput('down');
    view.handleInput('enter');
    assert.equal(selected.length, 1);
    assert.equal(selected[0], UNREGISTERED, 'the `a` list answers its own scope object');
  });

  test('the focused scope’s detail line follows the list on screen', () => {
    const { view } = mount({ scopes: [scope()], allScopes: [scope(), UNREGISTERED] });
    view.handleInput('a');
    view.handleInput('down');
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('an unrelated checkout'), rowsOf(view)[HEIGHT - 3]);
  });

  test('the toggle paints its key in the key role and its destination muted', () => {
    const theme = recordingTheme();
    const { view } = mount({ theme, scopes: [scope()], allScopes: [scope(), UNREGISTERED] });
    view.render(WIDTH);
    assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === 'a'));
    assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text === ' all'));
    view.handleInput('a');
    theme.calls.length = 0;
    view.render(WIDTH);
    assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text === ' registered'));
  });

  test('with no second list the key is not offered and does nothing', () => {
    const { view, selected, closes } = mount();
    const footer = rowsOf(view)[HEIGHT - 2];
    assert.ok(!footer.includes('a all') && !footer.includes('a registered'), footer);
    view.handleInput('a');
    assert.ok(rowsOf(view)[2].includes('▸ main'), 'the rows did not move');
    assert.deepEqual(selected, []);
    assert.deepEqual(closes, []);
  });
});

describe('keys (S9)', () => {
  test('down/ctrl+j and up/ctrl+k move the focus and stop at the ends', () => {
    const { view, renderCount } = mount();
    view.handleInput('down');
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('add the scope step'));
    view.handleInput('down');
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('add the scope step'));
    view.handleInput('ctrl+k');
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('main subject'));
    view.handleInput('ctrl+k');
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('main subject'));
    assert.ok(renderCount() >= 2, 'a move requests a repaint');
  });

  test('enter and return select the focused scope once', () => {
    const { view, selected } = mount();
    view.handleInput('down');
    view.handleInput('enter');
    assert.equal(selected.length, 1);
    assert.equal(selected[0], WORKTREE);
    view.handleInput('enter');
    view.handleInput('down');
    assert.equal(selected.length, 1, 'the step is used once');
  });

  test('escape and ctrl+c close without selecting', () => {
    const escaped = mount();
    escaped.view.handleInput('escape');
    assert.deepEqual(escaped.selected, []);
    assert.equal(escaped.closes.length, 1);

    const ctrlC = mount();
    ctrlC.view.handleInput('ctrl+c');
    assert.equal(ctrlC.closes.length, 1);
    assert.deepEqual(ctrlC.selected, []);
  });

  test('a key release is ignored', () => {
    const { view, selected } = mount();
    view.handleInput('release');
    assert.deepEqual(selected, []);
    view.handleInput('enter');
    assert.equal(selected.length, 1);
  });

  test('with no scopes enter does nothing and escape still closes', () => {
    const { view, selected, closes } = mount({ scopes: [] });
    view.handleInput('enter');
    assert.deepEqual(selected, []);
    view.handleInput('escape');
    assert.equal(closes.length, 1);
  });

  test('a throwing select hands the close back and rethrows', () => {
    const { view, closes } = mount({
      onSelect: () => { throw new Error('handoff failed'); },
    });
    assert.throws(() => view.handleInput('enter'), /handoff failed/);
    assert.equal(closes.length, 1);
  });
});

describe('mouse (S9)', () => {
  test('hover repaints the hovered row in the key role and moving off clears it', () => {
    const theme = recordingTheme();
    const { view } = mount({ theme });
    view.render(WIDTH);
    const hovered = view.handleMouse(mouse({ y: 3 }));
    assert.deepEqual(hovered, { handled: true, render: true });
    view.render(WIDTH);
    assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === 'feat/x · files-picker'));

    const callsBefore = theme.calls.length;
    const cleared = view.handleMouse(mouse({ y: 1 }));
    // The row that was hovered has to be repainted plain again.
    assert.deepEqual(cleared, { handled: true, render: true });
    view.render(WIDTH);
    assert.ok(!theme.calls.slice(callsBefore).some((call) => call.role === 'accent' && call.text === 'feat/x · files-picker'));
  });

  test('the wheel moves the focus and never selects', () => {
    const { view, selected } = mount();
    view.render(WIDTH);
    assert.deepEqual(view.handleMouse(mouse({ y: 3, type: 'wheel', wheelDelta: 1 })), { handled: true, render: true });
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('add the scope step'));
    view.render(WIDTH);
    view.handleMouse(mouse({ y: 3, type: 'wheel', wheelDelta: -1 }));
    assert.ok(rowsOf(view)[HEIGHT - 3].includes('main subject'));
    assert.deepEqual(selected, []);
  });

  test('a click selects the row under it, even when another row had the focus', () => {
    const { view, selected } = mount();
    view.render(WIDTH);
    const result = view.handleMouse(mouse({ x: 4, y: 3, type: 'click', button: 'left' }));
    assert.deepEqual(result, { handled: true, render: true });
    assert.equal(selected.length, 1);
    assert.equal(selected[0], WORKTREE);
  });

  test('a press claims the gesture without selecting or repainting', () => {
    const { view, selected } = mount();
    view.render(WIDTH);
    assert.deepEqual(view.handleMouse(mouse({ y: 3, type: 'press', button: 'left' })), { handled: true, render: false });
    assert.deepEqual(selected, []);
  });

  test('events outside the body and events from another geometry are not handled', () => {
    const { view } = mount();
    view.render(WIDTH);
    assert.equal(view.handleMouse(mouse({ x: 0, y: 3, type: 'click', button: 'left' })), undefined);
    assert.equal(view.handleMouse(mouse({ y: 0, type: 'click', button: 'left' })), undefined);
    assert.equal(view.handleMouse(mouse({ y: 40, type: 'click', button: 'left' })), undefined);
    assert.equal(view.handleMouse(mouse({ width: 60, type: 'click', button: 'left' })), undefined);
    assert.equal(view.handleMouse(null), undefined);
  });

  test('invalidate drops the hover and the hit geometry', () => {
    const { view } = mount();
    view.render(WIDTH);
    view.handleMouse(mouse({ y: 3 }));
    view.invalidate();
    assert.equal(view.handleMouse(mouse({ y: 3, type: 'click', button: 'left' })), undefined);
  });

  test('a completed step ignores every later event', () => {
    const { view, selected, closes } = mount();
    view.render(WIDTH);
    view.handleInput('escape');
    assert.equal(view.handleMouse(mouse({ y: 3, type: 'click', button: 'left' })), undefined);
    view.handleInput('enter');
    assert.deepEqual(selected, []);
    assert.equal(closes.length, 1);
    // The step still paints a stable frame if the host asks once more; it only
    // stops taking input.
    assert.equal(view.render(WIDTH).length, HEIGHT);
  });
});

describe('degradations (S9)', () => {
  test('with no scopes the card says so explicitly', () => {
    const theme = recordingTheme();
    const { view } = mount({ scopes: [], theme });
    const rows = rowsOf(view);
    const empty = rows.find((row) => row.includes('No checkouts to choose from.'));
    assert.ok(empty, 'the empty state is painted');
    assert.ok(theme.calls.some((call) => call.role === 'dim' && call.text.includes('No checkouts to choose from.')));
  });

  test('a hostile theme still paints every row at the requested width', () => {
    const hostile = {
      fg() { throw new Error('no colour'); },
      bold() { throw new Error('no bold'); },
      bg() { throw new Error('no band'); },
    };
    const { view } = mount({ theme: hostile });
    const rows = view.render(WIDTH);
    assert.equal(rows.length, HEIGHT);
    for (const row of rows) assert.equal(helpers.visibleWidth(row), WIDTH);
    assert.ok(strip(rows[2]).includes('main'));
  });

  test('an absent theme leaves the text plain', () => {
    const view = createFilesScopeView({ scopes: SCOPES, rowsAvailable: HEIGHT, helpers, now: NOW });
    const rows = rowsOf(view);
    assert.ok(rows[2].includes('main'));
    assert.ok(rows[HEIGHT - 2].includes('esc close'));
  });

  test('a hostile key matcher falls through to the spelled key name', () => {
    const { view, selected } = mount({
      helpers: {
        ...helpers,
        matchesKey() { throw new Error('no matcher'); },
      },
    });
    view.handleInput('down');
    view.handleInput('enter');
    assert.equal(selected.length, 1);
    assert.equal(selected[0], WORKTREE);
  });
});

describe('the list window (S9)', () => {
  function manyScopes(count) {
    const list = [scope()];
    for (let index = 0; index < count; index += 1) {
      list.push(scope({
        root: `/w/${index}`,
        label: `worktree-${index}`,
        kind: 'worktree',
        lastModifiedMs: 1000 - index,
      }));
    }
    return list;
  }

  test('more scopes than rows stay one window with more-indicators', () => {
    const { view } = mount({ scopes: manyScopes(8), rowsAvailable: 10 });
    const rows = rowsOf(view);
    assert.ok(rows.some((row) => row.includes('↓') && row.includes('more')), rows.join('\n'));
    assert.ok(!rows.some((row) => row.includes('↑') && row.includes('more')));
    assert.ok(rows[2].includes('▸ main'));
  });

  test('moving to the end flips the indicator without leaving the window', () => {
    const { view } = mount({ scopes: manyScopes(8), rowsAvailable: 10 });
    for (let step = 0; step < 8; step += 1) {
      view.handleInput('down');
      view.render(WIDTH);
    }
    const rows = rowsOf(view);
    assert.ok(rows.some((row) => row.includes('↑') && row.includes('more')), rows.join('\n'));
    assert.ok(rows.some((row) => row.includes('▸')), 'the focused row is inside the window');
  });

  test('a body too short for indicators paints only reachable rows', () => {
    const { view } = mount({ scopes: manyScopes(5), rowsAvailable: 8 });
    const rows = rowsOf(view);
    assert.ok(!rows.some((row) => row.includes('more')), rows.join('\n'));
    assert.equal(rows.length, 8);
  });
});

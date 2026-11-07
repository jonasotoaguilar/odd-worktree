'use strict';
// Lib unit tests for lib/warp-create-picker.js (pure Node, no subprocess, no
// prompt): pagination, the reusable multi-select component driven with
// synthetic keys, the single-select prompt and the inline name input.
//
// S1: the ISSUE and ODD selection plumbing is gone with the association
// itself — no `gh` fetch shape, no open-issue matcher, no `odd/tasks` listing,
// no pick-item adapters and no issue/ODD creation steps. The tests that pinned
// them were removed WITH the code (they asserted the removed contract), and
// the absence is pinned below so the datasets cannot quietly come back.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const picker = require('../lib/warp-create-picker.js');

// Optional real dependency: the host's pi-tui package. CI installs NO
// dependencies, so resolve it once here and SKIP the tests that genuinely
// need the real module instead of failing (the
// worktree-warp-real-session pattern). Every test that only needs the
// raw-byte fallback keeps running everywhere, with or without the package.
let TUI_AVAILABLE = false;
try {
  require.resolve('@earendil-works/pi-tui');
  TUI_AVAILABLE = true;
} catch {
  TUI_AVAILABLE = false;
}
if (!TUI_AVAILABLE) {
  console.error(
    'warp-create-picker: SKIPPING real-matcher tests (no @earendil-works/pi-tui found; '
    + 'install the package, e.g. npm install @earendil-works/pi-tui, to run them)',
  );
}

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function track(p) {
  roots.push(p);
  return p;
}

function scratchDir(tag) {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-pick-${tag}-`)));
}

// S1: worktrees receive no issue or ODD association, so the module carries no
// dataset plumbing for them any more. Pinned as an ABSENCE: the names are the
// removed contract, and a future re-add would reintroduce an association
// surface the create flow must not have.
describe('S1: no issue or ODD selection plumbing survives', { concurrency: false }, () => {
  test('the module exports no issue/ODD fetch, listing, matcher or pick-item adapter', () => {
    for (const name of [
      'ghFetchArgv', 'resolveGhBin', 'fetchOpenIssues', 'fetchOpenIssuesAsync',
      'listOddTaskDocs', 'filterIssueItems', 'filterOddItems', 'issuePickItems', 'oddPickItems',
      'GH_FETCH_LIMIT_DEFAULT',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(picker, name), false, `lib/warp-create-picker.js no longer exports ${name}`);
    }
  });

  test('the code runs no `gh` issue query and reads no odd/tasks directory', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../lib/warp-create-picker.js'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    assert.ok(!code.includes("'issue', 'list'"), 'no gh issue list argv');
    assert.ok(!code.includes('odd/tasks'), 'no odd/tasks listing');
    assert.ok(!/fetchOpenIssues|issuePickItems|oddPickItems|listOddTaskDocs|filterIssueItems|filterOddItems/.test(code), 'no association data helper survives');
  });
});

describe('pagination', { concurrency: false }, () => {
  test('pages clamp and slice', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    assert.deepEqual(picker.paginate(items, 0, 5), { items: [0, 1, 2, 3, 4], page: 0, pageCount: 3, total: 12 });
    assert.deepEqual(picker.paginate(items, 2, 5).items, [10, 11], 'the last page holds the rest');
    assert.equal(picker.paginate(items, 9, 5).page, 2, 'a far page clamps to the last one');
    assert.equal(picker.paginate(items, -3, 5).page, 0, 'a negative page clamps to the first one');
    assert.deepEqual(picker.paginate([], 0, 5), { items: [], page: 0, pageCount: 1, total: 0 });
  });
});

describe('the reusable multi-select component', { concurrency: false }, () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const identityFilter = (rows, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(query));
  };

  function open(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select rows (optional)',
      items,
      filterFn: identityFilter,
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  function textOf(view, width = 90) {
    return view.render(width).join('\n');
  }

  test('it renders rules, prompt, search box, DATA rows only and a key footer', () => {
    const { view, finished } = open();
    const lines = view.render(90);
    const text = lines.join('\n');
    assert.ok(/^─+$/.test(lines[0]), 'a thin accent rule opens the component');
    assert.ok(/^─+$/.test(lines[lines.length - 1]), 'a thin accent rule closes it');
    assert.ok(text.includes('Select rows (optional)'), 'the prompt travels');
    assert.ok(text.includes('Search:'), 'the search box sits under the prompt');
    assert.ok(text.includes('row 1'), 'the first page shows');
    assert.ok(!text.includes('row 6'), 'the second page stays off-screen');
    assert.match(text, /page 1\/3/i, 'the footer names the page');
    assert.match(text, /enter.*confirm/i, 'the footer names Enter as the confirm key');
    assert.match(text, /space.*toggle/i, 'the footer names Space as the toggle key');
    assert.match(text, /←\/→ pages/i, 'the footer names LEFT/RIGHT as the page keys');
    assert.match(text, /tab.*back/i, 'the footer reserves Tab for Back');
    assert.match(text, /t search/i, 'the footer names T as the search key');
    assert.ok(!text.includes('← Back'), 'no selectable Back row renders anywhere');
    assert.ok(!text.includes('Back'), 'no Back row label renders anywhere');
    assert.ok(!text.includes('Confirm'), 'there is no Confirm row: Enter confirms');
    // Raw Tab is the only Back affordance: it returns without completing.
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back with no selectable row');
  });

  test('panels are standalone: no cross-field chips, tabs or step counters leak into the render', () => {
    const { view } = open({
      title: 'Select issues (optional)',
    });
    const text = textOf(view);
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('▸'), 'no chip strip renders');
    assert.ok(!text.includes('✓'), 'no answered-step mark renders');
    const { view: second } = open({ title: 'Select odd documents (optional)' });
    const again = textOf(second);
    assert.ok(!/\[\d+\/\d+\]/.test(again), 'the second panel carries no counter either');
    assert.ok(!again.includes('Issues') || !again.includes('Odd'), 'no joint Type/Name/Issues/Odd header groups the panels');
    assert.ok(again.includes('Select odd documents (optional)'), 'each panel keeps only its own title');
    // Pagination of THIS list is fine: it is not a wizard step indicator.
    assert.match(text, /page 1\/3/i, 'the page counter of the current list stays');
  });

  test('focused rows carry the distinct chevron and checked boxes align', () => {
    const { view } = open({ pageSize: 12 });
    view.handleInput('space');
    const lines = view.render(90);
    const row = lines.find((line) => line.includes('row 1'));
    assert.ok(row.includes('[x]'), 'the toggled box reads checked');
    assert.ok(row.includes('❯'), 'the focused row carries the chevron');
    const other = lines.find((line) => line.includes('row 2'));
    assert.ok(other.includes('[ ]'), 'the untoggled box reads empty');
  });

  test('moving pages shows the later rows', () => {
    const { view } = open();
    view.handleInput('pagedown');
    const text = textOf(view);
    assert.ok(text.includes('row 6'), 'the second page shows after pagedown');
    assert.ok(!text.includes('row 1\n') && !text.includes('row 1 '), 'the first page is gone');
    assert.match(text, /page 2\/3/i);
  });

  test('space toggles, enter confirms, tab goes back preserving values', () => {
    const { view, finished } = open();
    view.handleInput('down');
    assert.equal(view.state.focus, 'list', 'arrowing focuses the list');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [2], 'Space toggles the focused checkbox');
    assert.ok(textOf(view).includes('1 selected'), 'the footer counts the selection');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [], 'Space toggles it back off');
    assert.deepEqual(finished, [], 'toggling never completes');
    view.handleInput('space');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [2], uiState: { query: '', page: 0, cursor: 1 } }], 'Tab alone returns with selections and list position echoed');
    assert.deepEqual(view.state.selected, [2], 'the selections are kept for the return trip');
  });

  test('multi-word title queries keep working from the T search field', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('x');
    assert.equal(view.state.query, '', 'stray typing in list mode never filters');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T opens the dedicated search field');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.equal(view.state.query, 'row 1', 'the space typed into the query');
    const text = textOf(view);
    assert.ok(text.includes('row 1'), 'the filter narrows to row 1');
    assert.ok(!text.includes('row 2'), 'row 2 is filtered out');
    assert.deepEqual(view.state.selected, [], 'filtering never selects');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search for the list');
    assert.deepEqual(finished, [], 'leaving search never confirms');
    assert.equal(view.state.query, 'row 1', 'the filter is retained');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'Enter in list confirms, echoing the kept filter');
  });

  test('confirming with nothing selected is valid and carries an empty list', () => {
    const { view, finished } = open();
    // No Confirm row exists: Enter on the list confirms immediately.
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 0 } }]);
  });

  test('typing filters the rows and keeps working after a multi-selection', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [2, 3], 'two rows selected');
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.equal(view.state.query, 'row 1');
    const text = textOf(view);
    assert.ok(text.includes('row 1'), 'the filter narrows to row 1');
    assert.ok(!text.includes('row 2'), 'row 2 is filtered out');
    assert.deepEqual(view.state.selected, [2, 3], 'the selection survives filtering');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search first');
    assert.deepEqual(finished, [], 'leaving search never confirms');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [2, 3], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'Enter in list confirms the multi-selection, echoing the kept filter');
  });

  test('backspace edits the query', () => {
    const { view } = open({ pageSize: 12 });
    view.handleInput('t');
    view.handleInput('x');
    assert.equal(view.state.query, 'x');
    view.handleInput('backspace');
    assert.equal(view.state.query, '');
    assert.equal(view.state.mode, 'search', 'editing stays in the field');
  });

  // S4/S12: while the search field is active, Delete clears what was typed in
  // one keystroke instead of erasing it character by character. Backspace
  // keeps its one-character meaning, and neither key leaves the field.
  test('Delete clears the whole active query while Backspace removes one character', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('t');
    for (const char of 'row 1') view.handleInput(char);
    assert.equal(view.state.query, 'row 1');
    view.handleInput('\x1b[3~'); // the raw Delete sequence
    assert.equal(view.state.query, '', 'one Delete clears everything typed');
    assert.equal(view.state.mode, 'search', 'the search field stays active');
    assert.equal(view.state.page, 0);
    assert.ok(textOf(view).includes('row 6'), 'the full list is visible again');
    assert.deepEqual(finished, [], 'clearing the query never completes the step');

    for (const char of 'row 2') view.handleInput(char);
    view.handleInput('backspace');
    assert.equal(view.state.query, 'row ', 'Backspace still removes exactly one character');
    view.handleInput('delete');
    assert.equal(view.state.query, '', 'the installed matcher spelling clears it too');
  });

  test('the search footer advertises the clear key on its one row', () => {
    for (const width of [40, 80, 120]) {
      const { view } = open({ pageSize: 12 });
      view.handleInput('t');
      const lines = view.render(width).map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, ''));
      const legend = lines.filter((line) => /filter kept|back to list|tab|clear|esc cancel/i.test(line));
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.match(legend[0], /clear/i, `width ${width}: the active search names the clear key: ${legend[0]}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      view.handleInput('\x1b'); // leave the field for the list
      const listLines = view.render(width).map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, ''));
      assert.equal(listLines.filter((line) => /clear/i.test(line)).length, 0, `width ${width}: no clear hint while no search is active`);
    }
  });

  test('escape cancels the whole step', () => {
    const { view, finished } = open();
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('escape');
    assert.deepEqual(finished, [null], 'Esc finishes with null: cancel, not confirm');
  });

  test('a key release changes nothing', () => {
    const { view } = open({
      helpers: { isKeyRelease: () => true },
    });
    view.handleInput('down');
    view.handleInput('x');
    view.handleInput('enter');
    assert.equal(view.state.query, '', 'no typing leaked through the release guard');
  });

  test('it never crashes on hostile dimensions', () => {
    const { view } = open();
    assert.deepEqual(view.render(0), []);
    assert.deepEqual(view.render(-4), []);
  });
});

describe('freeze/cancel/key regression (S52: real matcher + raw fallback)', { concurrency: false }, () => {
  const items = [
    { id: 11, label: '#11 First' },
    { id: 12, label: '#12 Second' },
  ];
  const identityFilter = (rows, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(query));
  };

  function open(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items,
      filterFn: identityFilter,
      pageSize: 8,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  test("the installed matcher accepts the ids the picker passes ('escape', 'enter', 'tab')", { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    assert.equal(typeof tui.matchesKey, 'function', 'the host exposes matchesKey');
    // The explorer claim that 'escape' is invalid never executed: the
    // installed keys.js matches BOTH spellings, plus raw sequences.
    assert.equal(tui.matchesKey('\x1b', 'escape'), true, 'raw Esc matches escape');
    assert.equal(tui.matchesKey('\x1b', 'esc'), true, 'raw Esc matches esc');
    assert.equal(tui.matchesKey('\r', 'enter'), true, 'raw CR matches enter');
    assert.equal(tui.matchesKey('\r', 'return'), true, 'raw CR matches return');
    assert.equal(tui.matchesKey('\t', 'tab'), true, 'raw Tab matches tab');
  });

  test('with the real helpers, raw terminal keys drive the picker', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = open({ helpers });
    first.view.handleInput('\x1b');
    assert.deepEqual(first.finished, [null], 'raw Esc cancels');
    const second = open({ helpers });
    second.view.handleInput('\x1b[B');
    second.view.handleInput(' ');
    assert.deepEqual(second.view.state.selected, [12], 'raw arrow moved, raw Space toggled');
    second.view.handleInput('\r');
    assert.deepEqual(second.finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'raw CR confirms');
    const third = open({ helpers });
    third.view.handleInput('\t');
    assert.deepEqual(third.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back with selections and position echoed');
    const fourth = open({ helpers });
    fourth.view.handleInput('\x1b[C');
    assert.equal(fourth.view.state.page, 0, 'one page: RIGHT clamps');
  });

  test('without helpers, raw control sequences still work (never a dead picker)', () => {
    const esc = open();
    esc.view.handleInput('\x1b');
    assert.deepEqual(esc.finished, [null], 'raw Esc cancels with no helpers');
    const enter = open();
    enter.view.handleInput('\r');
    assert.deepEqual(enter.finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw CR confirms empty with no helpers');
    const space = open();
    space.view.handleInput(' ');
    assert.deepEqual(space.view.state.selected, [11], 'raw Space toggles the focused row');
    const tab = open();
    tab.view.handleInput('\t');
    assert.deepEqual(tab.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back, never toggles');
    const arrows = open();
    arrows.view.handleInput('\x1b[B');
    arrows.view.handleInput(' ');
    assert.deepEqual(arrows.view.state.selected, [12], 'raw arrow moves before toggling');
    const bs = open({ pageSize: 12 });
    bs.view.handleInput('t');
    bs.view.handleInput('x');
    bs.view.handleInput('\x7f');
    assert.equal(bs.view.state.query, '', 'raw DEL edits the query');
  });

  test('completion fires exactly once under an input storm', () => {
    const { view, finished } = open();
    view.handleInput('escape');
    view.handleInput('escape');
    view.handleInput('enter');
    view.handleInput('\x1b');
    view.handleInput('\r');
    view.handleInput('tab');
    view.handleInput(' ');
    assert.deepEqual(finished, [null], 'one cancel, never a second resolution');
    const confirm = open();
    confirm.view.handleInput('enter');
    confirm.view.handleInput('enter');
    confirm.view.handleInput('escape');
    confirm.view.handleInput('tab');
    assert.equal(confirm.finished.length, 1, 'one confirm, never a second resolution');
    assert.deepEqual(confirm.finished[0], { selected: [], uiState: { query: '', page: 0, cursor: 0 } });
    const back = open();
    back.view.handleInput('tab');
    back.view.handleInput('tab');
    back.view.handleInput('enter');
    assert.deepEqual(back.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'one back, never a second resolution');
  });

  test('Enter confirms the step (empty valid); Space toggles; no Confirm row, no Back row', () => {
    const { view, finished } = open();
    const text = view.render(90).join('\n');
    assert.ok(!text.includes('Confirm'), 'no Confirm row renders: Enter confirms');
    assert.ok(!text.includes('Back'), 'no selectable Back row renders: Tab goes back');
    // No phantom focus row after the last data item: the cursor roams
    // data rows only, so Enter on the last row still confirms.
    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter on the last data row confirms, never goes back');
  });

  test('Space toggles the focused checkbox without completing', () => {
    const { view, finished } = open();
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [11], 'Space toggles on');
    assert.deepEqual(finished, [], 'toggling never completes');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [], 'Space toggles off');
    view.handleInput('down');
    view.handleInput(' ');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter confirms the toggled selection');
  });

  test('Tab alone returns to the previous step; Enter always confirms, Space always toggles', () => {
    const { view, finished } = open();
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [12], 'the second item is selected');
    // No selectable Back row exists, so moving past the last data item
    // clamps there and Enter still confirms the selection.
    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter past the last row confirms, never a Back row');
    const viaSpace = open();
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput(' ');
    assert.deepEqual(viaSpace.view.state.selected, [12], 'Space past the last row toggles data, never a Back row');
    assert.deepEqual(viaSpace.finished, [], 'toggling never completes');
    const viaTab = open();
    viaTab.view.handleInput('down');
    viaTab.view.handleInput(' ');
    viaTab.view.handleInput('\t');
    assert.deepEqual(viaTab.finished, [{ back: true, selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'raw Tab alone goes back with values and position kept');
    assert.deepEqual(viaTab.view.state.selected, [12], 'the selections survive for the return trip');
  });

  test('initialSelected restores the previous pass selections', () => {
    const { view, finished } = open({ initialSelected: [12] });
    assert.deepEqual(view.state.selected, [12], 'the earlier selection survives the round trip');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 0 } }], 'Enter confirms the restored selection');
  });

  test('an empty filter renders no selectable rows; raw Tab still goes back', () => {
    const { view, finished } = open();
    view.handleInput('t');
    for (const ch of 'zzz-no-match') view.handleInput(ch);
    const text = view.render(90).join('\n');
    assert.ok(text.includes('(no matches)'), 'items filter out');
    assert.ok(!text.includes('Confirm'), 'no Confirm row appears on an empty filter either');
    assert.ok(!text.includes('Back'), 'no selectable Back row appears on an empty filter either');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search for the list');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [], uiState: { query: 'zzz-no-match', page: 0, cursor: 0 } }], 'raw Tab goes Back even with an empty filter');
  });

  test('T reopens the kept query; clearing it restores every row', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('t');
    for (const ch of 'zzz') view.handleInput(ch);
    assert.ok(view.render(120).join('\n').includes('(no matches)'), 'the live filter hides every row');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T reopens the field');
    assert.equal(view.state.query, 'zzz', 'the kept query is there for editing');
    for (let i = 0; i < 3; i += 1) view.handleInput('backspace');
    assert.equal(view.state.query, '', 'clearing empties the query');
    view.handleInput('enter');
    const text = view.render(120).join('\n');
    assert.ok(text.includes('#11 First') && text.includes('#12 Second'), 'clearing restores every row');
    assert.deepEqual(finished, [], 'nothing completed along the way');
  });

  test('Esc in search exits to the list without cancelling', () => {
    const { view, finished } = open();
    view.handleInput('t');
    view.handleInput('1');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list', 'Esc leaves search for the list');
    assert.equal(view.state.query, '1', 'the filter is retained');
    assert.deepEqual(finished, [], 'Esc in search never cancels the step');
    view.handleInput('escape');
    assert.deepEqual(finished, [null], 'Esc in list still cancels');
  });

  test('T and Space in search are text; arrows never page there', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null, done: () => {},
    });
    const textOf = () => view.render(120).join('\n');
    view.handleInput('t');
    view.handleInput('t');
    view.handleInput(' ');
    view.handleInput('t');
    assert.equal(view.state.query, 't t', 'T and Space type inside the field');
    view.handleInput('left');
    view.handleInput('right');
    assert.match(textOf(), /page 1\/3/i, 'LEFT/RIGHT in search never page');
    assert.equal(view.state.mode, 'search', 'the field stays open');
    const footer = textOf();
    assert.match(footer, /back to list/i, 'the search footer says how to leave');
    assert.match(footer, /filter kept/i, 'the search footer promises the retained filter');
  });

  test('selections persist across filters and pages', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null,
      filterFn: (list, q) => {
        const query = String(q || '').trim().toLowerCase();
        if (!query) return list;
        return list.filter((r) => r.label.toLowerCase().includes(query));
      },
      done: (out) => { finished.push(out); },
    });
    view.handleInput(' ');
    view.handleInput('right');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [1, 6], 'one per page');
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.deepEqual(view.state.selected, [1, 6], 'filtering keeps selections');
    view.handleInput('enter');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [1, 6], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'confirm carries selections across filters and pages');
  });

  test('LEFT/RIGHT turn item pages; selections and search survive', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null,
      done: (out) => { finished.push(out); },
    });
    const textOf = () => view.render(90).join('\n');
    assert.match(textOf(), /page 1\/3/i);
    view.handleInput('right');
    assert.match(textOf(), /page 2\/3/i, 'RIGHT turns to the next page');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [6], 'Space toggles on the new page');
    view.handleInput('left');
    assert.match(textOf(), /page 1\/3/i, 'LEFT turns back');
    view.handleInput('right');
    assert.deepEqual(view.state.selected, [6], 'the selection survives page changes');
    view.handleInput('right');
    view.handleInput('right');
    assert.match(textOf(), /page 3\/3/i, 'the last page clamps');
    view.handleInput('left');
    view.handleInput('left');
    view.handleInput('left');
    assert.match(textOf(), /page 1\/3/i, 'the first page clamps');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [6], uiState: { query: '', page: 0, cursor: 0 } }], 'Enter confirms across pages');
  });

  test('raw LEFT/RIGHT sequences page; raw arrows respect search mode', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null, done: () => {},
      filterFn: (list, q) => {
        const query = String(q || '').trim().toLowerCase();
        if (!query) return list;
        return list.filter((r) => r.label.toLowerCase().includes(query));
      },
    });
    const textOf = () => view.render(120).join('\n');
    view.handleInput('\x1b[C');
    assert.match(textOf(), /page 2\/3/i, 'raw RIGHT turns the page');
    view.handleInput('\x1b[D');
    assert.match(textOf(), /page 1\/3/i, 'raw LEFT turns back');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T opens the search field');
    view.handleInput('q');
    assert.equal(view.state.query, 'q', 'typing filters inside the field');
    assert.equal(view.state.page, 0, 'typing resets to the first page');
    view.handleInput('\x1b[C');
    assert.match(textOf(), /page 1\/1/i, 'raw RIGHT in search never pages');
    assert.equal(view.state.mode, 'search', 'search mode is kept');
    view.handleInput('\x1b[B');
    assert.equal(view.state.mode, 'list', 'raw DOWN moves from the search into the rows');
  });

});

describe('the inline name input (S52 Back on every field)', { concurrency: false }, () => {
  function open(overrides = {}) {
    const finished = [];
    const view = picker.createTextInput({
      title: 'New worktree change name',
      placeholder: 'name-change',
      initial: '',
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  test('it renders the questionnaire frame with a write footer and no cross-field header', () => {
    const { view } = open();
    const lines = view.render(90);
    const text = lines.join('\n');
    assert.ok(/^─+$/.test(lines[0]), 'a thin accent rule opens');
    assert.ok(/^─+$/.test(lines[lines.length - 1]), 'a thin accent rule closes');
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('Type') || !text.includes('Issues'), 'no joint Type Name Issues Odd header groups the panels');
    assert.ok(!text.includes('Odd'), 'the name panel leaks no Odd tab');
    assert.ok(text.includes('New worktree change name'), 'the panel keeps only its own title');
    assert.match(text, /enter.*confirm/i, 'Enter confirms');
    assert.match(text, /tab.*back/i, 'Tab goes back');
    assert.match(text, /esc.*cancel/i, 'Esc cancels');
  });

  test('the name field starts truly empty: no example text in the rendered input', () => {
    const { view } = open();
    assert.equal(view.state.value, '', 'the initial value is empty, not prefilled');
    const text = view.render(90).join('\n');
    assert.ok(!text.includes('name-change'), 'no example placeholder renders inside the input');
    assert.ok(!text.includes('picked'), 'no stale value renders either');
  });

  test('first typing lands as the actual value with the cursor after it', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const { view } = open();
    view.handleInput('a');
    assert.equal(view.state.value, 'a', 'the first keystroke is the actual value');
    const line = view.render(90).join('\n').split('\n').find((l) => l.includes('❯'));
    assert.ok(line, 'the input line renders');
    assert.ok(line.includes('a'), 'the typed value renders in the input line');
    const marker = tui.CURSOR_MARKER;
    const at = line.indexOf(marker);
    assert.ok(at >= 0, 'the real Pi cursor marker renders in the input line');
    assert.equal(line[at + marker.length], '▊', 'the visual cursor sits immediately after the marker');
    assert.ok(line.indexOf('a') < at, 'the marker (and cursor) sit after the actual value, never after a placeholder');
  });

  test('the cursor marker is zero-width: Unicode/ANSI width stays exact', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const { view } = open();
    for (const ch of 'caf\u00e9 \u4e2d') view.handleInput(ch);
    const line = view.render(120).join('\n').split('\n').find((l) => l.includes('caf'));
    assert.ok(line, 'the unicode value renders');
    const stripped = String(line).replace(/\x1b\[[0-9;]*m/g, '');
    const withMarker = tui.visibleWidth(stripped);
    const withoutMarker = tui.visibleWidth(stripped.split(tui.CURSOR_MARKER).join(''));
    assert.equal(withMarker, withoutMarker - 1 + 1, 'marker is zero-width, cursor cell counts one');
    assert.ok(withoutMarker > [...'caf\u00e9 \u4e2d'].length, 'wide characters count wider than codepoints');
  });

  test('Back restores only the actually typed prior value, still with no example text', () => {
    const { view, finished } = open({ initial: 'picked' });
    assert.equal(view.state.value, 'picked', 'the actually typed value is restored');
    const text = view.render(90).join('\n');
    assert.ok(text.includes('picked'), 'the restored value renders');
    assert.ok(!text.includes('name-change'), 'the example never renders, even on return');
    view.handleInput('tab');
    assert.deepEqual(finished, [{ back: true, value: 'picked' }], 'Tab alone goes back carrying the typed value');
    assert.equal(view.state.value, 'picked', 'the typed value is kept for the return trip');
  });

  test('typing appends (spaces included), Enter submits, Esc cancels, Tab goes back', () => {
    const { view, finished } = open();
    for (const ch of 'my change') view.handleInput(ch);
    assert.equal(view.state.value, 'my change', 'spaces type in a text input');
    view.handleInput('backspace');
    assert.equal(view.state.value, 'my chang');
    view.handleInput('enter');
    assert.deepEqual(finished, ['my chang'], 'Enter submits the typed value');
  });

  test('Tab returns {back:true} with the typed value and Esc returns null, exactly once', () => {
    const tab = open();
    tab.view.handleInput('t');
    tab.view.handleInput('tab');
    assert.deepEqual(tab.finished, [{ back: true, value: 't' }], 'Tab alone goes back carrying the typed value');
    assert.equal(tab.view.state.value, 't', 'the typed value is kept for the return trip');
    tab.view.handleInput('tab');
    tab.view.handleInput('escape');
    assert.deepEqual(tab.finished, [{ back: true, value: 't' }], 'one back, never a second resolution');
    const esc = open();
    esc.view.handleInput('escape');
    esc.view.handleInput('enter');
    assert.deepEqual(esc.finished, [null], 'one cancel, never a second resolution');
  });

  test('the initial value is kept for editing', () => {
    const { view, finished } = open({ initial: 'picked' });
    assert.equal(view.state.value, 'picked', 'Back from a later step restores the kept name');
    view.handleInput('enter');
    assert.deepEqual(finished, ['picked'], 'submitting unchanged keeps it');
  });

  test('raw terminal keys drive it with real helpers', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = open({ helpers });
    first.view.handleInput('a');
    first.view.handleInput('\x7f');
    first.view.handleInput('b');
    first.view.handleInput('\t');
    assert.deepEqual(first.finished, [{ back: true, value: 'b' }], 'raw Tab goes back carrying the typed value with real helpers');
  });
  test('raw terminal keys drive it with the raw fallback (no helpers)', () => {
    const second = open();
    second.view.handleInput('x');
    second.view.handleInput('\x1b');
    assert.deepEqual(second.finished, [null], 'raw Esc cancels with no helpers');
    const third = open();
    third.view.handleInput('y');
    third.view.handleInput('\r');
    assert.deepEqual(third.finished, ['y'], 'raw CR submits with no helpers');
    const fourth = open();
    fourth.view.handleInput(' ');
    assert.equal(fourth.view.state.value, ' ', 'raw Space types with no helpers');
  });
});

describe('the inline type single-select (Tab Back, no selectable rows)', { concurrency: false }, () => {
  const TYPE_ITEMS = [
    'Feature (feat)', 'Bug fix (fix)', 'Chore (chore)', 'Docs (docs)', 'Style (style)',
    'Refactor (refactor)', 'Performance (perf)', 'Test (test)', 'Build (build)', 'CI (ci)', 'Revert (revert)',
  ];
  function openType(overrides = {}) {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'New worktree change type',
      items: TYPE_ITEMS,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('it renders eleven data rows only with a Tab-back footer', () => {
    const { view, finished } = openType();
    const text = view.render(90).join('\n');
    assert.equal(TYPE_ITEMS.length, 11, 'eleven conventional types');
    for (const item of TYPE_ITEMS) assert.ok(text.includes(item), `renders ${item}`);
    assert.ok(!text.includes('Back'), 'no selectable Back row anywhere');
    assert.ok(!text.includes('Confirm'), 'no selectable Confirm row anywhere');
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('Name') && !text.includes('Issues') && !text.includes('Odd'), 'the type panel leaks no other-field tabs');
    assert.ok(text.includes('New worktree change type'), 'the panel keeps only its own title');
    assert.match(text, /enter.*confirm/i, 'the footer names Enter as confirm');
    assert.match(text, /tab.*back/i, 'the footer names Tab as back');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true }], 'raw Tab returns Back (single-select carries no list state)');
  });
  test('raw keys with the real matcher: arrows move, Enter confirms, Tab goes back', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = openType({ helpers });
    first.view.handleInput('\x1b[B');
    first.view.handleInput('\r');
    assert.deepEqual(first.finished, ['Bug fix (fix)'], 'raw arrow moved, raw CR confirmed the data row');
    const second = openType({ helpers });
    second.view.handleInput('\t');
    assert.deepEqual(second.finished, [{ back: true }], 'raw Tab goes Back with the real matcher');
    const third = openType({ helpers });
    third.view.handleInput('\x1b');
    assert.deepEqual(third.finished, [null], 'raw Esc cancels');
  });
  test('Enter on the last data row confirms; no phantom row after it', () => {
    const { view, finished } = openType();
    for (let i = 0; i < 20; i += 1) view.handleInput('down');
    view.handleInput('\r');
    assert.deepEqual(finished, ['Revert (revert)'], 'clamped on the last data row, Enter confirms it');
  });
  test('prior selection on return restores the cursor', () => {
    const { view, finished } = openType({ initialSelected: 'Bug fix (fix)' });
    view.handleInput('\r');
    assert.deepEqual(finished, ['Bug fix (fix)'], 'the kept type confirms directly');
  });
});

describe('multi-select revisit state (query, page, cursor, selections)', { concurrency: false }, () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const filterFn = (list, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return list;
    return list.filter((r) => r.label.toLowerCase().includes(query));
  };
  function openRevisit(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select rows (optional)',
      items: rows,
      filterFn,
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('initialQuery/initialPage/initialCursor restore the previous pass', () => {
    const { view } = openRevisit({ initialQuery: 'row 1', initialPage: 0, initialCursor: 2 });
    assert.equal(view.state.query, 'row 1', 'the kept filter is restored');
    assert.equal(view.state.cursor, 2, 'the kept cursor is restored');
    const text = view.render(120).join('\n');
    assert.ok(text.includes('row 12'), 'the filter still narrows (row 1, 10, 11, 12)');
    assert.ok(!text.includes('row 3'), 'unmatched rows stay filtered out');
    assert.match(text, /page 1\/1/i, 'the restored page fits the filtered list');
  });
  test('Tab Back echoes selections and uiState with a raw Tab', () => {
    const { view, finished } = openRevisit();
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [2], 'the second row is toggled');
    view.handleInput('t');
    view.handleInput('1');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [2], uiState: { query: '1', page: 0, cursor: 0 } }], 'raw Tab carries selections plus filter/page/cursor');
  });
  test('Enter confirm echoes uiState alongside the selection', () => {
    const { view, finished } = openRevisit();
    view.handleInput(' ');
    view.handleInput('\r');
    assert.deepEqual(finished, [{ selected: [1], uiState: { query: '', page: 0, cursor: 0 } }], 'raw CR confirms with the list position echoed');
  });
  test('a revisit round-trips filter, page and cursor through the echo', () => {
    const first = openRevisit();
    first.view.handleInput('right');
    first.view.handleInput('t');
    for (const ch of 'row 1') first.view.handleInput(ch);
    first.view.handleInput('\t');
    assert.equal(first.finished.length, 1, 'one back resolution');
    const echo = first.finished[0].uiState;
    assert.equal(echo.query, 'row 1', 'the filter travels in the echo');
    const second = openRevisit({
      initialQuery: echo.query,
      initialPage: echo.page,
      initialCursor: echo.cursor,
      initialSelected: first.finished[0].selected,
    });
    assert.equal(second.view.state.query, 'row 1', 'the revisit restores the filter');
    const text = second.view.render(120).join('\n');
    assert.ok(text.includes('row 1'), 'filtered rows render on revisit');
    second.view.handleInput('\r');
    assert.deepEqual(second.finished, [{ selected: [], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'confirm on revisit carries the restored filter');
  });
});

describe('warp selector Ctrl+D delete (single-select extension)', { concurrency: false }, () => {
  const ITEMS = ['principal — /tmp/principal', 'feat-one — /tmp/one', 'Create new worktree…'];
  // Eligible: every checkout row except the principal (index 0) and the
  // create row (last). Mirrors the warp selector rule: principal and
  // create are never deletable.
  const canDelete = (index) => index === 1;
  function openWarp(overrides = {}) {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'Warp session · current: principal /tmp/principal',
      items: ITEMS,
      helpers: null,
      hostTui: null,
      theme: null,
      canDelete,
      confirmLabel: 'warp',
      showTab: false,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('raw Ctrl+D (\\x04) via the raw fallback invokes delete on the eligible row', () => {
    const { view, finished } = openWarp();
    view.handleInput('down');
    assert.equal(view.state.cursor, 1, 'focus on the eligible worktree');
    view.handleInput('\x04');
    assert.deepEqual(finished, [{ delete: true, index: 1, value: ITEMS[1] }], 'raw Ctrl+D deletes the focused eligible row');
  });
  test('raw Ctrl+D via the installed matcher invokes delete on the eligible row', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    assert.equal(tui.matchesKey('\x04', 'ctrl+d'), true, 'precondition: the installed matcher owns Ctrl+D');
    const { view, finished } = openWarp({ helpers: { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease } });
    view.handleInput('down');
    view.handleInput('\x04');
    assert.deepEqual(finished, [{ delete: true, index: 1, value: ITEMS[1] }], 'installed matcher Ctrl+D deletes');
  });
  test('Ctrl+D on principal and create rows is a safe no-op', () => {
    const { view, finished } = openWarp();
    assert.equal(view.state.cursor, 0, 'starts on the principal');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'principal never deletes');
    view.handleInput('down');
    view.handleInput('down');
    assert.equal(view.state.cursor, 2, 'focus on the create row');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'create never deletes');
    view.handleInput('\r');
    assert.deepEqual(finished, [ITEMS[2]], 'Enter still confirms the create row');
  });
  test('footer shows Ctrl+D only on the eligible row with the actual key', () => {
    const { view } = openWarp();
    const principalFooter = view.render(90).join('\n');
    assert.match(principalFooter, /enter.*warp/i, 'footer names Enter warp');
    assert.ok(!principalFooter.includes('Ctrl+D'), 'no delete hint on the principal row');
    assert.ok(!principalFooter.includes('Tab'), 'no Tab hint when showTab is false');
    view.handleInput('down');
    const eligibleFooter = view.render(90).join('\n');
    assert.ok(eligibleFooter.includes('Ctrl+D delete'), 'the actual Ctrl+D key shows only on the eligible row');
    view.handleInput('down');
    const createFooter = view.render(90).join('\n');
    assert.ok(!createFooter.includes('Ctrl+D'), 'no delete hint on the create row');
  });
  test('Enter still warps and Esc still cancels with the warp footer', () => {
    const first = openWarp();
    first.view.handleInput('down');
    first.view.handleInput('\r');
    assert.deepEqual(first.finished, [ITEMS[1]], 'Enter confirms the focused checkout');
    const second = openWarp();
    second.view.handleInput('\x1b');
    assert.deepEqual(second.finished, [null], 'Esc cancels');
  });
  test('without canDelete the footer and keys stay byte-identical to before', () => {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'New worktree change type',
      items: ['Feature (feat)', 'Bug fix (fix)'],
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
    });
    const text = view.render(90).join('\n');
    assert.match(text, /enter.*confirm/i, 'default confirm verb unchanged');
    assert.match(text, /tab.*back/i, 'default Tab hint unchanged');
    assert.ok(!text.includes('Ctrl+D'), 'no delete hint without canDelete');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'Ctrl+D without canDelete does nothing');
  });
});

describe('S64 footer totals (T50, test-first RED)', () => {
  function openTotals(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` })),
      filterFn: (rows, q) => {
        const raw = String(q ?? '').trim().toLowerCase();
        if (raw === '') return rows.slice();
        return rows.filter((r) => String(r.label).toLowerCase().includes(raw));
      },
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  function textOf(view, width = 90) {
    return view.render(width).join('\n');
  }
  test('unfiltered footer names the TOTAL available count', () => {
    const { view } = openTotals();
    const text = textOf(view);
    assert.match(text, /12\s*total/i, 'the original loaded length travels as TOTAL');
    assert.match(text, /0\s*selected/i, 'selection count stays');
    assert.match(text, /page 1\/3/i, 'page stays');
  });
  test('filtered footer distinguishes filtered-available from TOTAL', () => {
    const { view } = openTotals({ pageSize: 12 });
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    view.handleInput('enter');
    const text = textOf(view);
    assert.match(text, /4\s*of\s*12/i, 'filtered 4 of TOTAL 12, never calling the filtered count the total');
    assert.match(text, /selected/i, 'selection count stays');
    assert.match(text, /page 1\/1/i, 'page stays');
  });
  test('empty list keeps an exact zero TOTAL and a single page', () => {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items: [],
      filterFn: (rows) => rows.slice(),
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
    });
    const text = view.render(90).join('\n');
    assert.match(text, /0\s*total/i, 'empty TOTAL is exact');
    assert.match(text, /page 1\/1/i, 'empty list still yields one page');
  });
  test('paging keeps TOTAL stable across pages with a selection', () => {
    const { view } = openTotals();
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('pagedown');
    const text = textOf(view);
    assert.match(text, /12\s*total/i, 'TOTAL survives paging');
    assert.match(text, /1\s*selected/i, 'selection survives paging');
    assert.match(text, /page 2\/3/i, 'page advances');
  });
});

// S2: every picker footer is ONE terminal row; a footer wider than the panel
// is compacted (short tokens, then the lowest-priority keys dropped), never
// ellipsis-clipped and never wrapped.
describe('S2: one-row key legends', { concurrency: false }, () => {
  const WIDTHS = [40, 60, 80, 120];
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const base = { helpers: null, hostTui: null, theme: null, done: () => {} };

  function legendRows(lines, marker) {
    return lines.filter((line) => marker.test(line));
  }

  test('the write prompt footer owns exactly one row at every width', () => {
    for (const width of WIDTHS) {
      const view = picker.createTextInput({ ...base, title: 'Name', placeholder: 'name-change', initial: '' });
      const lines = view.render(width);
      const legend = legendRows(lines, /esc cancel/i);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /esc cancel/i, `width ${width}: the cancel key survives`);
    }
  });

  test('the single-select footer owns exactly one row at every width', () => {
    for (const width of WIDTHS) {
      const view = picker.createSingleSelect({ ...base, title: 'Type', items: ['feat', 'fix', 'docs'] });
      const lines = view.render(width);
      const legend = legendRows(lines, /esc cancel/i);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /esc cancel/i, `width ${width}: the cancel key survives`);
    }
  });

  test('the multi-select list and search footers own exactly one row at every width', () => {
    for (const width of WIDTHS) {
      const view = picker.createMultiSelect({
        ...base,
        title: 'Select rows (optional)',
        items: rows,
        pageSize: 5,
        filterFn: (list, q) => list.filter((item) => item.label.includes(String(q || ''))),
      });
      const listLines = view.render(width);
      const listLegend = legendRows(listLines, /esc cancel/i);
      assert.equal(listLegend.length, 1, `width ${width}: exactly one list legend row, got ${listLegend.length}`);
      assert.ok(!listLegend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${listLegend[0]}`);
      assert.match(listLegend[0], /esc cancel/i, `width ${width}: the cancel key survives`);
      view.handleInput('t');
      const searchLines = view.render(width);
      const searchLegend = legendRows(searchLines, /filter kept|back to list|Enter\/Esc keep|Tab back|tab/);
      assert.equal(searchLegend.length, 1, `width ${width}: exactly one search legend row, got ${searchLegend.length}`);
      assert.ok(!searchLegend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${searchLegend[0]}`);
    }
  });
});

// S11/T9: every picker footer and header paints through the ONE shared palette
// (lib/tui-paint.js) with the injected theme — a shortcut KEY (a button) is
// accent+bold and its description muted, a TITLE takes the reference UI's `dim`
// title role and stays bold, a static label is dim, a live value (the typed
// query, the typed name) is the normal text role, a count is muted, and a rule
// takes the border role. A hostile or absent theme degrades to plain text, and
// the one-row compaction keeps the key role at every width.
// This module renders no error text: S1 removed the dataset fetches together
// with their skip messages, so the palette's error role has no call site here.
describe('S11: the shared palette', { concurrency: false }, () => {
  const ROLE_SGR = { accent: 96, customMessageLabel: 33, muted: 90, dim: 2, border: 34, error: 91, text: 39, mdHeading: 35 };
  // T9 (S13): the title role is the reference UI's `dim` (its Agents title:
  // ~/.config/herdr-app/mods/agents/main.js:413), asserted LITERALLY — the test
  // pins the decision instead of reading it back out of the table.
  const TITLE_PAINT = '\x1b[1m\x1b[33m';
  const VALUE_PAINT = '\x1b[39m';

  // A theme that RECORDS which role painted each string and paints every role
  // with its own SGR code, so a rendered line can be read for the ROLE behind a
  // token instead of trusting an eyeballed colour.
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

  function stripAnsi(text) {
    return String(text)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b_[^\x07\x1b]*\x07/g, '');
  }

  // The raw (still painted) line carrying `needle`.
  function findRaw(lines, needle) {
    const line = lines.find((entry) => stripAnsi(entry).includes(needle));
    assert.ok(line !== undefined, `no line contains ${JSON.stringify(needle)}\n${lines.map(stripAnsi).join('\n')}`);
    return line;
  }

  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const narrow = (list, q) => {
    const query = String(q ?? '').trim().toLowerCase();
    if (query === '') return list.slice();
    return list.filter((item) => String(item.label).toLowerCase().includes(query));
  };

  function openMulti(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select rows',
      items: rows,
      filterFn: narrow,
      pageSize: 5,
      searchPlaceholder: 'type to filter',
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  function openSingle(overrides = {}) {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'Type',
      items: ['feat', 'fix'],
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  function openWrite(overrides = {}) {
    const finished = [];
    const view = picker.createTextInput({
      title: 'Name',
      placeholder: 'name-change',
      initial: '',
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  test('the multi-select footer paints every key accent+bold and its description muted', () => {
    const theme = recordingTheme();
    const { view } = openMulti({ theme });
    const legend = findRaw(view.render(100), 'Esc cancel');
    assert.match(legend, /\x1b\[1m\x1b\[96m↑↓\x1b\[0m\x1b\[22m\x1b\[90m move/,
      'the move key is accent+bold and its words muted');
    assert.match(legend, /\x1b\[1m\x1b\[96m←\/→\x1b\[0m\x1b\[22m\x1b\[90m pages/, 'so is the page key');
    assert.match(legend, /\x1b\[1m\x1b\[96mT\x1b\[0m\x1b\[22m\x1b\[90m search/, 'and the search key');
    assert.match(legend, /\x1b\[1m\x1b\[96mSpace\x1b\[0m\x1b\[22m\x1b\[90m toggle/, 'and the toggle key');
    assert.match(legend, /\x1b\[1m\x1b\[96mEnter\x1b\[0m\x1b\[22m\x1b\[90m confirm/, 'and the confirm key');
    assert.match(legend, /\x1b\[1m\x1b\[96mEsc\x1b\[0m\x1b\[22m\x1b\[90m cancel/, 'and the cancel key');
    assert.match(legend, /\x1b\[34m · \x1b\[0m/, 'the entries are joined by the border role');
    assert.ok(theme.calls.some((call) => call.role === 'bold' && call.text.includes('Enter')),
      'the key is bolded through the theme, never by a literal escape');
    assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text === ' confirm'),
      'the description asks the injected theme for the muted role');
  });

  test('the search footer paints its keys and its descriptions', () => {
    const theme = recordingTheme();
    const { view } = openMulti({ theme });
    view.handleInput('t');
    const legend = findRaw(view.render(100), 'back to list');
    assert.match(legend, /\x1b\[1m\x1b\[96mEnter\/Esc\x1b\[0m\x1b\[22m\x1b\[90m back to list \(filter kept\)/,
      'the leave-search key is accent+bold with a muted description');
    assert.match(legend, /\x1b\[1m\x1b\[96mdelete\x1b\[0m\x1b\[22m\x1b\[90m clear/, 'so is the clear key');
    assert.match(legend, /\x1b\[1m\x1b\[96mTab\x1b\[0m\x1b\[22m\x1b\[90m back/, 'and the back key');
    assert.match(legend, /\x1b\[90mSearch\x1b\[0m/, 'the field name is words, never a key');
    assert.match(legend, /\x1b\[90mtype to filter\x1b\[0m/, 'so is the typing hint');
    assert.ok(!/\x1b\[1m\x1b\[96mSearch/.test(legend), 'no prose token borrows the key role');
  });

  test('the single-select and write-prompt footers paint keys and descriptions', () => {
    const single = recordingTheme();
    const singleLegend = findRaw(openSingle({ theme: single }).view.render(100), 'Esc cancel');
    assert.match(singleLegend, /\x1b\[1m\x1b\[96mEnter\x1b\[0m\x1b\[22m\x1b\[90m confirm/, 'the confirm key is accent+bold');
    assert.match(singleLegend, /\x1b\[1m\x1b\[96mEsc\x1b\[0m\x1b\[22m\x1b\[90m cancel/, 'so is the cancel key');
    assert.match(singleLegend, /\x1b\[1m\x1b\[96mTab\x1b\[0m\x1b\[22m\x1b\[90m back/, 'and the back key');

    const write = recordingTheme();
    const writeLegend = findRaw(openWrite({ theme: write }).view.render(100), 'Esc cancel');
    assert.match(writeLegend, /\x1b\[1m\x1b\[96mEnter\x1b\[0m\x1b\[22m\x1b\[90m confirm/, 'the write prompt names its confirm key');
    assert.match(writeLegend, /\x1b\[1m\x1b\[96mEsc\x1b\[0m\x1b\[22m\x1b\[90m cancel/, 'and its cancel key');
    assert.match(writeLegend, /\x1b\[90mtype to write\x1b\[0m/, 'typing is prose, never a key');
  });

  // T9 (S13): the picker's title is a TITLE — the theme's secondary heading
  // role, bold — while the rules keep the border role and the keys stay the
  // primary accent a button owns.
  test('titles take the shared title role+bold and rules take the border role', () => {
    const theme = recordingTheme();
    const opened = [openMulti({ theme }), openSingle({ theme }), openWrite({ theme })];
    for (const { view } of opened) {
      const lines = view.render(100);
      assert.match(lines[0], /^\x1b\[34m─+\x1b\[0m$/, 'the opening rule is the border role');
      assert.match(lines[lines.length - 1], /^\x1b\[34m─+\x1b\[0m$/, 'the closing rule is the border role');
      assert.ok(lines[1].startsWith(TITLE_PAINT), 'the title is the shared title role, bold');
      assert.ok(lines[1].endsWith('\x1b[0m\x1b[22m'), 'the emphasis closes through the theme');
    }
    for (const title of ['Select rows', 'Type', 'Name']) {
      assert.ok(theme.calls.some((call) => call.role === 'customMessageLabel' && call.text === title),
        `the ${title} title asks the injected theme for the title role`);
      assert.ok(!theme.calls.some((call) => call.role === 'accent' && call.text === title),
        `the ${title} title never borrows the button accent`);
    }
    assert.ok(!theme.calls.some((call) => call.role === 'error'), 'no error role is painted on a healthy render');
  });

  // T9 (S13): a typed query and a typed name are ordinary text, so they stay
  // out of the accent a button owns; counts and the empty-list note stay muted.
  test('counts are muted, the search label dim and the live query ordinary text', () => {
    const theme = recordingTheme();
    const { view } = openMulti({ theme });
    assert.match(findRaw(view.render(100), 'total'),
      /^\x1b\[90m12 total · 0 selected · page 1\/3\x1b\[0m$/, 'the counts row is the muted role');
    const idle = findRaw(view.render(100), 'Search:');
    assert.match(idle, /\x1b\[2mSearch: \x1b\[0m/, 'the box label is the dim role');
    assert.match(idle, /\x1b\[90mtype to filter\x1b\[0m/, 'the idle placeholder is muted, never a value');
    view.handleInput('t');
    for (const ch of 'ro') view.handleInput(ch);
    const live = findRaw(view.render(100), 'Search:');
    assert.ok(live.includes(`${VALUE_PAINT}ro\x1b[0m`), 'the typed query is the normal text role');
    assert.ok(!/\x1b\[96mro\x1b\[0m/.test(live), 'the typed query is never the button accent');
    for (const ch of 'w zzz') view.handleInput(ch);
    assert.match(findRaw(view.render(100), '(no matches)'),
      /\x1b\[90m\(no matches\)\x1b\[0m/, 'the empty-list note is muted, never an error');

    const typed = recordingTheme();
    const write = openWrite({ theme: typed, initial: 'typed' });
    assert.ok(findRaw(write.view.render(100), 'typed').includes(`${VALUE_PAINT}typed\x1b[0m`),
      'the typed name is ordinary text');
  });

  test('a hostile theme never breaks a render and keeps every key readable', () => {
    const hostile = {
      fg() { throw new Error('no colour support'); },
      bold() { throw new Error('no bold support'); },
      bg() { throw new Error('no background support'); },
    };
    const { view } = openMulti({ theme: hostile });
    const lines = view.render(90);
    const text = lines.map(stripAnsi).join('\n');
    assert.ok(lines.every((line) => !line.includes('\x1b')), 'a throwing theme paints nothing');
    assert.ok(text.includes('Select rows'), 'the title still renders');
    assert.ok(text.includes('12 total'), 'the counts still render');
    assert.ok(text.includes('type to filter'), 'the placeholder still renders');
    assert.ok(text.includes('↑↓ move · ←/→ pages · T search · Space toggle · Enter confirm · Tab back · Esc cancel'),
      'the legend still spells every key');
    assert.equal(lines.filter((line) => stripAnsi(line).includes('Esc cancel')).length, 1, 'and stays on ONE row');
  });

  test('one-row compaction keeps the key role at every width', () => {
    for (const width of [40, 60, 80, 120]) {
      const theme = recordingTheme();
      const { view } = openMulti({ theme });
      const listLegend = findRaw(view.render(width), 'Esc cancel');
      assert.match(listLegend, /\x1b\[1m\x1b\[96mEsc\x1b\[0m\x1b\[22m\x1b\[90m cancel/,
        `width ${width}: the compacted cancel key keeps accent+bold`);
      assert.ok(!listLegend.includes('…'), `width ${width}: compacted, never ellipsis-clipped`);
      assert.ok([...stripAnsi(listLegend)].length <= width,
        `width ${width}: the painted legend still fits the panel`);
      view.handleInput('t');
      const searchLegend = findRaw(view.render(width), 'Enter/Esc');
      assert.match(searchLegend, /\x1b\[1m\x1b\[96mEnter\/Esc\x1b\[0m\x1b\[22m\x1b\[90m (keep|back to list)/,
        `width ${width}: the compact spelling keeps its key role`);
      assert.ok([...stripAnsi(searchLegend)].length <= width,
        `width ${width}: the painted search legend still fits the panel`);
    }
    for (const width of [40, 80]) {
      const single = recordingTheme();
      const singleLegend = findRaw(openSingle({ theme: single }).view.render(width), 'Esc cancel');
      assert.match(singleLegend, /\x1b\[1m\x1b\[96mEsc\x1b\[0m\x1b\[22m\x1b\[90m cancel/, `width ${width}: the single-select cancel key keeps its role`);
      assert.ok([...stripAnsi(singleLegend)].length <= width, `width ${width}: the painted single-select legend fits`);
      const write = recordingTheme();
      const writeLegend = findRaw(openWrite({ theme: write }).view.render(width), 'Esc cancel');
      assert.match(writeLegend, /\x1b\[1m\x1b\[96mEsc\x1b\[0m\x1b\[22m\x1b\[90m cancel/, `width ${width}: the write-prompt cancel key keeps its role`);
      assert.ok([...stripAnsi(writeLegend)].length <= width, `width ${width}: the painted write legend fits`);
    }
  });
});

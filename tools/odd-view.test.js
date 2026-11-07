'use strict';
// T3/T4 (odd-viewer S3,S4,S6) tests: lib/odd-view.js — the two-pane odd
// viewer component (list on the left, styled document on the right).
//
// Contract under test, as observable output only: the component renders
// exactly the requested rows at the requested width; the left pane lists the
// display names without extension or path; moving the selection swaps the
// right pane and resets its scroll; the right pane scrolls to the last line
// of a long document; an empty checkout, an unreadable document and an empty
// document each render their own state instead of fake content; `esc` closes
// with a null result and mutates nothing; `r` re-lists.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createOddView } = require('../lib/odd-view.js');
const layout = require('../lib/view-layout.js');

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

// Optional real host helpers: the extension injects the pi-tui module
// namespace. CI installs no dependencies, so the byte-level assertions run
// only when it resolves; every raw-byte assertion works without it.
let realTui = null;
try {
  realTui = require('@earendil-works/pi-tui');
} catch {
  realTui = null;
}
const cellWidth = (line) => (realTui && typeof realTui.visibleWidth === 'function'
  ? realTui.visibleWidth(line)
  : [...strip(line)].length);

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text) };

// S11/T9: a theme that RECORDS which role it was asked to paint each string
// with and paints every role with its own SGR code, so a rendered line can be
// read for the ROLE behind a token instead of trusting an eyeballed colour.
// T9 (S13): the title role is `customMessageLabel`, the one the Pi Agents view
// paints its own frame title with (`gentle-pi/lib/agents-view.ts:42,437`), which
// the recording theme paints with SGR 33; `text` is normal body text and
// `accent` the buttons.
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

function doc(name) {
  return { name, file: `${name}.md`, path: `/checkout/odd/tasks/${name}.md` };
}

function makeView({ docs, load, reloadDocs, rows = 20 } = {}) {
  const paints = [];
  let settled = 'pending';
  const view = createOddView({
    docs,
    loadDoc: load,
    reloadDocs,
    helpers,
    theme: plainTheme,
    rowsAvailable: () => rows,
    requestRender: () => { paints.push(true); },
    done: (result) => { settled = result; },
  });
  return { view, done: () => settled, paints };
}

const longDoc = (lines) => Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n');

describe('createOddView rendering', () => {
  test('renders a framed two-pane view at the requested size with the document names on the left', async () => {
    const { view } = makeView({
      docs: [doc('alpha'), doc('beta')],
      load: () => ({ ok: true, text: '# alpha\n\n## Specs\nS1. first rule\n' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lines = view.render(80);
    assert.equal(lines.length, 20, 'the view fills the available rows');
    for (const line of lines) assert.equal(helpers.visibleWidth(line), 80, `not 80 wide: "${strip(line)}"`);
    const body = strip(lines.join('\n'));
    assert.match(body, /✎ Odd · 2 documents/, 'the title carries the document count');
    assert.match(body, /alpha/, 'the selected document name is listed');
    assert.match(body, /beta/, 'the other document name is listed');
    assert.ok(!body.includes('alpha.md'), 'the extension is not shown in the list');
    assert.ok(!body.includes('/checkout/odd/tasks'), 'no path is shown in the list');
    assert.match(body, /S1\. first rule/, 'the right pane shows the selected document content');
    assert.match(body, /esc close/, 'the footer names the close key');
  });

  test('moving the selection swaps the document and resets its scroll', async () => {
    const contents = { alpha: `# alpha\n${longDoc(80)}`, beta: '# beta\n\nonly beta body\n' };
    const { view } = makeView({
      docs: [doc('alpha'), doc('beta')],
      load: (entry) => ({ ok: true, text: contents[entry.name] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.handleInput('J');
    const scrolled = strip(view.render(80).join('\n'));
    assert.ok(view.state.scroll > 0, 'shift+j scrolls the right pane');
    assert.match(scrolled, /line 1\b/, 'the first line is still on screen right after scrolling one row');
    view.handleInput('down');
    const swapped = strip(view.render(80).join('\n'));
    assert.equal(view.state.index, 1, 'down selects the next document');
    assert.equal(view.state.scroll, 0, 'the scroll resets on the new document');
    assert.match(swapped, /only beta body/, 'the right pane shows the newly selected document');
  });

  test('scrolls to the last line of a long document and back to the top', async () => {
    const total = 120;
    const { view } = makeView({
      docs: [doc('alpha')],
      load: () => ({ ok: true, text: longDoc(total) }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.handleInput('end');
    const bottom = strip(view.render(80).join('\n'));
    assert.match(bottom, /line 120/, 'the last source line is reachable');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0, 'home returns to the top');
    assert.match(strip(view.render(80).join('\n')), /line 1\b/);
  });
});

describe('createOddView states', () => {
  test('a checkout without documents renders its empty state, not an empty frame', async () => {
    const { view } = makeView({ docs: [], load: () => ({ ok: true, text: '' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /✎ Odd · 0 documents/);
    assert.match(body, /no odd documents/i);
    assert.match(body, /odd\/tasks/);
  });

  test('an unreadable document renders its error instead of empty content', async () => {
    const { view } = makeView({
      docs: [doc('alpha')],
      load: () => ({ ok: false, error: 'EACCES: permission denied' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /EACCES: permission denied/);
  });

  test('esc closes with a null result and mutates nothing', async () => {
    const { view, done } = makeView({ docs: [doc('alpha')], load: () => ({ ok: true, text: '# alpha\n' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(done(), 'pending');
    view.handleInput('escape');
    assert.equal(done(), null);
    assert.equal(view.state.index, 0);
    assert.equal(view.state.scroll, 0);
  });

  test('r re-lists through reloadDocs, so a document written while open appears', async () => {
    let current = [doc('alpha')];
    const { view } = makeView({
      docs: current,
      load: (entry) => ({ ok: true, text: `# ${entry.name}\n` }),
      reloadDocs: () => ({ ok: true, docs: current }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(strip(view.render(80).join('\n')), /1 documents/);
    current = [doc('alpha'), doc('gamma')];
    view.handleInput('r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /2 documents/);
    assert.match(body, /gamma/);
  });
});

// S10b: the odd viewer is read-only with respect to the checkout↔document
// association. The options the existing callers still pass (`assigned`,
// `saveAssignment`, `assignmentEnabled`) are accepted and ignored: no mark,
// no toggle, no save, no unsaved claim — and no key that writes.
describe('createOddView read-only association (S10b)', () => {
  function makeInertView({ docs, rows = 20, ...rest } = {}) {
    const calls = [];
    let settled = 'pending';
    const view = createOddView({
      docs,
      loadDoc: (entry) => ({ ok: true, text: `# ${entry.name}\n` }),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: (result) => { settled = result; },
      ...rest,
      saveAssignment: (...args) => { calls.push(args); return { ok: true }; },
    });
    return { view, calls, done: () => settled };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const ASSIGNED = ['odd/tasks/alpha.md'];
  // The list rows are the cells between the left border and the divider; the
  // title icon (`✎`) and the legend separators (`·`) live outside them.
  const listRows = (body) => body.split('\n').filter((line) => /│ [▸ ] (alpha|beta)( |$)/.test(line));

  test('no association mark renders and the status row carries no assigned or unsaved fact', async () => {
    const { view } = makeInertView({
      docs: [doc('alpha'), doc('beta')],
      assigned: ASSIGNED,
      assignmentEnabled: true,
      checkoutName: 'demo-checkout',
    });
    await tick();
    const body = strip(view.render(80).join('\n'));
    const rows = listRows(body);
    assert.equal(rows.length, 2, 'both documents still list');
    assert.ok(rows.every((line) => !/[✓✎]/.test(line)), 'no association mark on any row');
    assert.match(rows[0], /▸ alpha/, 'the focused row renders unmarked');
    assert.ok(!body.includes('assigned'), 'no assigned count is claimed');
    assert.ok(!body.includes('unsaved'), 'no unsaved indicator exists');
    assert.ok(!body.includes('space toggle'), 'the space toggle leaves the legend');
    assert.ok(!body.includes('ctrl+s'), 'the save key leaves the legend');
    assert.match(body, /ctrl\+j\/k doc/, 'the reading keys stay in the legend, naming the default pair and its target (S14)');
    assert.match(body, /esc close/, 'the close key stays in the legend');
  });

  test('space and ctrl+s change nothing: no save call, no state change, no repaint difference', async () => {
    const { view, calls } = makeInertView({ docs: [doc('alpha'), doc('beta')], assigned: ASSIGNED });
    await tick();
    const snapshot = JSON.stringify(view.state);
    const rendered = view.render(80).join('\n');
    for (const key of ['space', ' ', 'ctrl+s', '\x13', 'space', 'ctrl+s']) view.handleInput(key);
    await tick();
    assert.deepEqual(calls, [], 'the injected save callback is never reached');
    assert.equal(JSON.stringify(view.state), snapshot, 'no state changed');
    assert.equal(view.render(80).join('\n'), rendered, 'nothing repainted differently');
  });

  test('the association options are inert: the frame is identical with, without and with the gate off', async () => {
    const docs = [doc('alpha'), doc('beta')];
    const plain = makeInertView({ docs });
    const passed = makeInertView({ docs, assigned: ASSIGNED, assignmentEnabled: true, checkoutName: 'demo-checkout' });
    const gatedOff = makeInertView({ docs, assigned: ASSIGNED, assignmentEnabled: false });
    await tick();
    const expected = plain.view.render(80).join('\n');
    assert.equal(passed.view.render(80).join('\n'), expected, 'assigned/saveAssignment/assignmentEnabled change no cell');
    assert.equal(gatedOff.view.render(80).join('\n'), expected, 'assignmentEnabled false changes no cell either');
  });

  test('the viewer still opens, navigates, filters, scrolls, reloads and closes with the options passed', async () => {
    const long = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
    let current = [doc('alpha'), doc('beta')];
    const { view, done } = makeInertView({
      docs: current,
      assigned: ASSIGNED,
      assignmentEnabled: false,
      loadDoc: () => ({ ok: true, text: long }),
      reloadDocs: () => ({ ok: true, docs: current }),
    });
    await tick();
    view.handleInput('down');
    assert.equal(view.state.index, 1, 'navigation still works');
    view.handleInput('up');
    assert.equal(view.state.index, 0, 'navigation still works both ways');
    view.handleInput('T');
    view.handleInput('b');
    view.handleInput('enter');
    const narrowed = strip(view.render(80).join('\n')).split('\n');
    assert.ok(!narrowed.some((line) => /│ [▸ ] alpha *│/.test(line)), 'the filter still narrows the list');
    view.handleInput('/');
    view.handleInput('\x7f');
    view.handleInput('enter');
    const cleared = strip(view.render(80).join('\n')).split('\n');
    assert.ok(cleared.some((line) => /│ [▸ ] alpha *│/.test(line)), 'the filter still clears');
    view.handleInput('J');
    assert.ok(view.state.scroll > 0, 'the preview still scrolls');
    current = [doc('alpha'), doc('beta'), doc('gamma')];
    view.handleInput('r');
    await tick();
    assert.match(strip(view.render(80).join('\n')), /3 documents/, 'reload still re-lists');
    view.handleInput('escape');
    assert.equal(done(), null, 'esc still closes with a null result');
  });

});

describe('createOddView key consistency (K3)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function makeKeyView({ docs, openImpl } = {}) {
    const opened = [];
    let settled = 'pending';
    const open = (...args) => {
      opened.push(args);
      if (typeof openImpl === 'function') return openImpl(...args);
      return { ok: true };
    };
    const view = createOddView({
      docs: docs || [doc('alpha'), doc('beta'), doc('gamma')],
      loadDoc: (entry) => ({ ok: true, text: `# ${entry.name}\n` }),
      openExternal: open,
      helpers,
      theme: plainTheme,
      rowsAvailable: () => 20,
      requestRender: () => {},
      done: (result) => { settled = result; },
    });
    return { view, opened, done: () => settled };
  }

  test('? is inert: no key-help overlay, and esc closes the view directly', async () => {
    const { view, done } = makeKeyView();
    await tick();
    assert.ok(!strip(view.render(80).join('\n')).includes('Keys'), 'no help before ?');
    view.handleInput('?');
    const body = strip(view.render(80).join('\n'));
    assert.ok(!body.includes('Keys'), '? does not open a help overlay');
    assert.ok(!body.includes('? help'), 'the footer does not hint a help key');
    view.handleInput('escape');
    assert.equal(done(), null, 'esc with no overlay closes the view');
  });

  test('T filters the document list by name, live as you type, and leaving the box keeps the filter', async () => {
    const { view } = makeKeyView();
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('l');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /alpha/, 'the matching document stays');
    assert.ok(!body.includes('beta') || body.includes('filter'), 'non-matching rows leave the list');
    const rows = body.split('\n').filter((line) => /│ [▸ ] /.test(line));
    assert.ok(rows.every((line) => !line.includes('beta') && !line.includes('gamma')), 'only the match is listed');
    assert.match(body, / › al/, 'the filter is visible while typing');
    view.handleInput('enter');
    const kept = strip(view.render(80).join('\n'));
    assert.match(kept, /› al( |$)/m, 'leaving the box keeps the filter');
    assert.match(kept, /alpha/);
    const keptRows = kept.split('\n').filter((line) => /[▸ ] [✓·✎] /.test(line));
    assert.ok(keptRows.every((line) => !line.includes('beta') && !line.includes('gamma')), 'the filter still applies after leaving the box');
  });

  test('/ also opens the filter box', async () => {
    const { view } = makeKeyView();
    await tick();
    view.handleInput('/');
    view.handleInput('g');
    view.handleInput('a');
    view.handleInput('m');
    view.handleInput('enter');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /› gam( |$)/m, 'the / filter is kept like the T filter');
    assert.match(body, /gamma/);
    assert.ok(!body.split('\n').filter((line) => /│ [▸ ] /.test(line)).some((line) => line.includes('alpha')), 'alpha is filtered out');
  });

  test('a filter matching nothing renders its empty state instead of a blank frame', async () => {
    const { view } = makeKeyView();
    await tick();
    view.handleInput('T');
    view.handleInput('z');
    view.handleInput('z');
    view.handleInput('z');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /no matches/, 'the empty filter names itself');
    assert.match(body, /› zzz/, 'the query stays visible');
  });

  test('o opens the focused document through the injected opener', async () => {
    const { view, opened } = makeKeyView();
    await tick();
    view.handleInput('down');
    view.handleInput('o');
    await tick();
    assert.equal(opened.length, 1, 'one external open for one o');
    assert.equal(opened[0][0], '/checkout/odd/tasks/beta.md', 'the opener receives the focused absolute path');
    const body = strip(view.render(80).join('\n'));
    assert.ok(!body.includes('open failed'), 'a successful open shows no error');
    assert.equal(view.state.index, 1, 'the selection is untouched');
  });

  test('a failing opener reports the error honestly and keeps the selection', async () => {
    const { view, opened } = makeKeyView({ openImpl: () => ({ ok: false, error: 'spawn ed ENOENT' }) });
    await tick();
    view.handleInput('o');
    await tick();
    assert.equal(opened.length, 1);
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /open failed: spawn ed ENOENT/, 'the failure is shown, never silent');
    assert.equal(view.state.index, 0, 'the selection is untouched');
  });

  test('o with an empty document list does nothing', async () => {
    const { view, opened } = makeKeyView({ docs: [] });
    await tick();
    view.handleInput('o');
    await tick();
    assert.deepEqual(opened, [], 'nothing to open, nothing called');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /no odd documents/, 'the empty state survives');
  });

  test('the footer names every key the view gained', async () => {
    const { view } = makeKeyView();
    await tick();
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /› Search/, 'the search row is the search widget');
    assert.match(body, /t search|(^|· )t( ·|$)/, 'the footer names the filter key (S4)');
    assert.match(body, /o open/, 'the footer names the external-open key');
    assert.ok(!body.includes('? help'), 'the footer no longer hints the removed help key');
  });
});

// ---------------------------------------------------------------------------
// warp-usability T4: S13 (scroll), S14 (no help), S23-S27 (search row,
// concise title, frame cells, no top-right esc) and S29 (assignment gate).
// These feed the public render/handleInput/handleMouse surface with the raw
// terminal bytes and wheel events the host emits.
// ---------------------------------------------------------------------------
describe('createOddView warp usability (S13,S14,S23-S27,S29)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const skipReal = realTui ? false : 'requires @earendil-works/pi-tui';
  const body200 = longDoc(200);

  function build({ docs = [doc('alpha'), doc('beta')], rows = 20, load, ...rest } = {}) {
    const paints = [];
    let settled = 'pending';
    const view = createOddView({
      docs,
      loadDoc: load || (() => ({ ok: true, text: body200 })),
      helpers: realTui || helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => { paints.push(true); },
      done: (result) => { settled = result; },
      ...rest,
    });
    return { view, paints, done: () => settled };
  }

  test('the mouse wheel scrolls the preview without touching the selection', { skip: skipReal }, async () => {
    const { view } = build();
    view.render(80);
    assert.equal(typeof view.handleMouse, 'function', 'the view accepts host mouse events');
    assert.equal(view.state.scroll, 0);
    view.handleMouse({ type: 'wheel', button: 'none', x: 60, y: 10, screenX: 60, screenY: 10, width: 80, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: 4 });
    assert.equal(view.state.scroll, 4, 'a down wheel moves the preview down');
    assert.equal(view.state.index, 0, 'the wheel never moves the list selection');
    view.handleMouse({ type: 'wheel', wheelDelta: -2 });
    assert.equal(view.state.scroll, 2, 'an up wheel moves the preview back up');
    view.handleMouse({ type: 'wheel', wheelDelta: -50 });
    assert.equal(view.state.scroll, 0, 'the top bound clamps');
    view.handleMouse({ type: 'wheel', wheelDelta: 1e6 });
    const bottom = view.state.scroll;
    assert.ok(bottom > 0, 'a huge down wheel reaches the bottom page');
    view.handleMouse({ type: 'wheel', wheelDelta: 1e6 });
    assert.equal(view.state.scroll, bottom, 'the bottom bound clamps');
    view.handleMouse({ type: 'wheel', wheelDelta: -1 });
    assert.equal(view.state.scroll, bottom - 1, 'the preview scrolls back from the bottom');
  });

  test('SGR wheel bytes scroll the preview through handleInput', () => {
    const { view } = build();
    view.render(80);
    view.handleInput('\x1b[<65;60;10M');
    assert.equal(view.state.scroll, 1, 'SGR wheel down scrolls the preview');
    view.handleInput('\x1b[<65;60;10M');
    assert.equal(view.state.scroll, 2);
    view.handleInput('\x1b[<64;60;10M');
    assert.equal(view.state.scroll, 1, 'SGR wheel up scrolls back');
    assert.equal(view.state.index, 0, 'wheel bytes never move the list selection');
  });

  test('raw scroll bytes drive the preview with no helpers (never a dead preview)', () => {
    const { view } = build({ helpers: null });
    view.render(80);
    view.handleInput('\n');            // Enter, and the legacy ctrl+j byte
    assert.equal(view.state.scroll, 0, 'bare LF never scrolls: it is Enter');
    view.handleInput('\x0b');          // legacy ctrl+k byte
    assert.equal(view.state.scroll, 0, 'the old ctrl+k byte no longer scrolls');
    view.handleInput('\x1b[106;6u');   // CSI-u ctrl+shift+j
    assert.ok(view.state.scroll > 0, 'raw ctrl+shift+j scrolls down');
    const pressed = view.state.scroll;
    view.handleInput('\x1b[106;6:3u'); // the release of the same key
    assert.equal(view.state.scroll, pressed, 'a key release never scrolls');
    view.handleInput('\x1b[107;6u');   // CSI-u ctrl+shift+k
    assert.equal(view.state.scroll, 0, 'raw ctrl+shift+k scrolls back up');
    view.handleInput('\x1b[6~');       // PageDown
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'raw PageDown scrolls a page');
    view.handleInput('\x1b[5~');       // PageUp
    assert.equal(view.state.scroll, 0, 'raw PageUp scrolls the page back');
    view.handleInput('\x1b[F');        // End
    assert.ok(view.state.scroll > 0, 'raw End reaches the bottom');
    view.handleInput('\x1b[H');        // Home
    assert.equal(view.state.scroll, 0, 'raw Home returns to the top');
    assert.equal(view.state.index, 0, 'scroll keys never move the list selection');
    view.handleInput('\x1b[B');        // Down moves the list, not the preview
    assert.equal(view.state.index, 1, 'raw Down moves the selection');
    assert.equal(view.state.scroll, 0, 'the scroll resets on the new document');
  });

  test('the real host keyboard bytes scroll the preview and keep the selection separate', { skip: skipReal }, () => {
    const { view } = build();
    view.render(80);
    view.handleInput('\n');     // a newline: Enter, and the legacy ctrl+j byte
    assert.equal(view.state.scroll, 0, 'the host calls this byte enter, so it never scrolls');
    view.handleInput('\x0b');   // the legacy ctrl+k byte
    assert.equal(view.state.scroll, 0, 'the host calls this byte ctrl+k, not a scroll key');
    view.handleInput('\x1b[106;6u'); // Kitty ctrl+shift+j
    assert.ok(view.state.scroll > 0, 'ctrl+shift+j scrolls through the real matcher');
    view.handleInput('\x1b[6~'); // PageDown
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'PageDown scrolls a page');
    view.handleInput('\x1b[5~'); // PageUp
    assert.ok(view.state.scroll < paged, 'PageUp scrolls the page back');
    view.handleInput('\x1b[F');  // End
    assert.ok(view.state.scroll > 0, 'End reaches the bottom');
    view.handleInput('\x1b[H');  // Home
    assert.equal(view.state.scroll, 0, 'Home returns to the top');
    assert.equal(view.state.index, 0, 'no scroll key moved the list selection');
    view.handleInput('\x1b[B');
    assert.equal(view.state.index, 1, 'Down still moves the list selection');
  });

  // S1: the full-page pair is the shifted one the user asked for — ctrl+shift+
  // j/k through the extended protocol, and the printable J/K fallback on a
  // legacy terminal — while ctrl+d/ctrl+u stay the distinct half-page shortcut.
  test('S1: ctrl+shift+j/k and shifted J/K page the preview, j/k still move the list', { skip: skipReal }, () => {
    const { view } = build();
    view.render(80);
    view.handleInput('\x1b[6~');            // PageDown: the full-page step
    const paged = view.state.scroll;
    view.handleInput('\x1b[H');
    assert.equal(view.state.scroll, 0, 'home returns to the top first');
    view.handleInput('\x04');               // ctrl+d
    const half = view.state.scroll;
    assert.ok(half > 0, 'raw ctrl+d scrolls the preview down');
    assert.ok(half < paged, 'ctrl+d moves half a page, less than PageDown');
    assert.equal(view.state.index, 0, 'ctrl+d never moves the list selection');
    view.handleInput('\x15');               // ctrl+u
    assert.equal(view.state.scroll, 0, 'raw ctrl+u scrolls the preview back up');
    view.handleInput('\x1b[100;5u');        // Kitty ctrl+d
    assert.ok(view.state.scroll > 0, 'Kitty ctrl+d scrolls the preview down');
    view.handleInput('\x1b[117;5u');        // Kitty ctrl+u
    assert.equal(view.state.scroll, 0, 'Kitty ctrl+u scrolls the preview back up');
    view.handleInput('K');                  // shifted K pages up
    view.handleInput('\x04');
    view.handleInput('K');
    assert.equal(view.state.scroll, 0, 'K pages the preview back up');
    view.handleInput('J');                  // shifted J pages down
    assert.equal(view.state.scroll, paged, 'J pages exactly what PageDown pages');
    assert.equal(view.state.index, 0, 'J never moves the list selection');
    view.handleInput('\x1b[H');
    view.handleInput('\x1b[106;6u');        // Kitty ctrl+shift+j
    assert.equal(view.state.scroll, paged, 'ctrl+shift+j pages exactly what PageDown pages');
    view.handleInput('\x1b[107;6u');        // Kitty ctrl+shift+k
    assert.equal(view.state.scroll, 0, 'ctrl+shift+k pages back up');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'j still moves the list selection');
    assert.equal(view.state.scroll, 0, 'j never scrolls the preview');
    view.handleInput('k');
    assert.equal(view.state.index, 0, 'k still moves the list selection');
    view.handleInput('\x1b[6~');
    assert.equal(view.state.scroll, paged, 'PageDown still scrolls a full page');
    view.handleInput('\x1b[5~');
    assert.equal(view.state.scroll, 0, 'PageUp still scrolls the page back');
  });

  test('S15: the half-page and fallback keys also work with no helpers injected', () => {
    const { view } = build({ helpers: null });
    view.render(80);
    view.handleInput('\x04');
    const half = view.state.scroll;
    assert.ok(half > 0, 'raw ctrl+d scrolls with no helpers');
    view.handleInput('\x15');
    assert.equal(view.state.scroll, 0, 'raw ctrl+u scrolls back with no helpers');
    view.handleInput('\x04');
    view.handleInput('K');
    assert.equal(view.state.scroll, 0, 'K pages back up with no helpers');
    view.handleInput('J');
    assert.ok(view.state.scroll > half, 'J pages a full page with no helpers, more than ctrl+d');
    assert.equal(view.state.index, 0, 'J never moves the list selection without helpers');
    view.handleInput('\x1b[100;5u');        // Kitty ctrl+d
    const kittyDown = view.state.scroll;
    assert.ok(kittyDown > half, 'Kitty ctrl+d scrolls further down with no helpers');
    view.handleInput('\x1b[117;5u');        // Kitty ctrl+u
    assert.ok(view.state.scroll < kittyDown, 'Kitty ctrl+u scrolls back with no helpers');
    view.handleInput('\x1b[H');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'j still moves the list selection without helpers');
  });

  test('the scroll keys repaint without writing anything', { skip: skipReal }, async () => {
    const calls = [];
    const { view, paints } = build({ saveAssignment: (...args) => { calls.push(args); return { ok: true }; } });
    view.render(80);
    const before = paints.length;
    view.handleInput('\x1b[6~');
    assert.ok(paints.length > before, 'scrolling requests a repaint');
    assert.deepEqual(calls, [], 'scrolling never calls the save callback');
  });

  test('? no longer opens a key-help overlay and the footer never hints it', () => {
    const { view } = build();
    view.handleInput('?');
    const body = strip(view.render(80).join('\n'));
    assert.ok(!body.includes('Keys'), 'no help overlay');
    assert.ok(!body.includes('? help'), 'no ? hint in the footer');
    assert.ok(!/\?/.test(body), 'no bare ? anywhere in the frame');
  });

  test('the title carries only the viewer name and the document count', () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta')], checkoutName: 'demo-checkout' });
    const lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[0]), /✎ Odd · 2 documents/);
    assert.ok(!lines[0].includes('demo-checkout'), 'no checkout/worktree name in the title');
    assert.ok(!lines[0].includes('alpha'), 'no selected document in the title');
    assert.ok(!lines[0].includes('esc'), 'no top-right esc in the frame');
    assert.ok(!strip(lines.join('\n')).includes('demo-checkout'), 'the checkout name is gone from the whole frame');
  });

  test('the search row sits directly below the title and carries the query and the position marks', () => {
    const { view } = build();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('l');
    let lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al█/, 'typing shows the live query on its own row');
    assert.ok(!strip(lines[0]).includes('1/2'), 'the count is not buried in the title');
    view.handleInput('enter');
    lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al( |$)/m, 'leaving the box keeps the query visible');
    view.handleInput('/');
    lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al█/, '/ edits the same row');
  });

  test('the frame fills every cell with aligned corners and no top-right esc at 80x24 and 160x40', () => {
    for (const [width, rows] of [[80, 24], [160, 40]]) {
      const { view } = build({ rows });
      const lines = view.render(width);
      assert.equal(lines.length, rows, `${width}x${rows}: the view fills the rows`);
      lines.forEach((line, at) => {
        assert.equal(cellWidth(line), width, `${width}x${rows} row ${at} is ${width} cells: "${line}"`);
      });
      const plain = strip(lines.join('\n')).split('\n');
      assert.equal(plain[0][0], '╭', 'top-left corner');
      assert.equal(plain[0][width - 1], '╮', 'top-right corner in the last cell');
      assert.equal(plain[rows - 1][0], '╰', 'bottom-left corner');
      assert.equal(plain[rows - 1][width - 1], '╯', 'bottom-right corner in the last cell');
      for (let at = 1; at < rows - 1; at += 1) {
        assert.equal(plain[at][0], '│', `row ${at} left border`);
        assert.equal(plain[at][width - 1], '│', `row ${at} right border in the last cell`);
      }
      assert.ok(!plain.slice(0, 4).join('').includes('esc'), 'no top-right esc text');
    }
  });

  test('the preview shows the start, a middle page and the end at 80x24 and 160x40 with the query row visible', () => {
    for (const [width, rows] of [[80, 24], [160, 40]]) {
      const { view } = build({ rows });
      let body = strip(view.render(width).join('\n'));
      assert.equal(view.state.scroll, 0, `${width}x${rows}: the start is the top`);
      assert.match(body, /line 1\b/, `${width}x${rows}: the first source line is visible at the start`);
      assert.match(body.split('\n')[1], /› Search/, `${width}x${rows}: the query row is visible`);
      view.handleInput('\x1b[6~');
      body = strip(view.render(width).join('\n'));
      assert.ok(view.state.scroll > 0, `${width}x${rows}: PageDown reaches a middle window`);
      assert.ok(!/\bline 1\b/.test(body), `${width}x${rows}: the start left the middle window`);
      assert.ok(!/\bline 200\b/.test(body), `${width}x${rows}: the end is not yet visible in the middle window`);
      view.handleInput('\x1b[F');
      body = strip(view.render(width).join('\n'));
      assert.match(body, /\bline 200\b/, `${width}x${rows}: End reaches the last source line`);
      assert.ok(!/\bline 1\b/.test(body), `${width}x${rows}: the start left the end window`);
      view.handleInput('\x1b[H');
      body = strip(view.render(width).join('\n'));
      assert.equal(view.state.scroll, 0, `${width}x${rows}: Home returns to the top`);
      assert.match(body, /line 1\b/, `${width}x${rows}: the start is visible again`);
    }
  });

  test('the inherited name filter stays case-insensitive and keeps the selection inside the visible list', () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta'), doc('gamma')] });
    view.handleInput('T');
    view.handleInput('G');
    view.handleInput('a');
    let body = strip(view.render(80).join('\n'));
    const filterRows = (text) => text.split('\n').filter((line) => /│ [▸ ] (alpha|beta|gamma)( |$)/.test(line));
    const rows = filterRows(body);
    assert.equal(rows.length, 1, 'an uppercase query still matches the lowercase name');
    assert.match(rows[0], /gamma/, 'only the case-insensitive match is listed');
    assert.ok(!body.split('\n').some((line) => /│ [▸ ] (alpha|beta) *│/.test(line)), 'the filter hides the other rows');
    assert.ok(body.split('\n').some((line) => /│ ▸ gamma *│/.test(line)), 'the only match stays focused');
    view.handleInput('enter');
    view.handleInput('down');
    assert.equal(view.state.index, 0, 'one match has nowhere to move');
    view.handleInput('/');
    view.handleInput('\x7f');
    body = strip(view.render(80).join('\n'));
    assert.equal(filterRows(body).length, 1, 'Backspace edits the kept query');
    view.handleInput('\x7f');
    view.handleInput('enter');
    body = strip(view.render(80).join('\n'));
    const cleared = filterRows(body);
    assert.equal(cleared.length, 3, 'clearing the query restores every document');
  });

  test('the raw DEL byte edits the kept query even with no host helpers injected', () => {
    const { view } = build({ helpers: null, docs: [doc('alpha'), doc('beta'), doc('gamma')] });
    view.handleInput('T');
    view.handleInput('G');
    view.handleInput('a');
    view.handleInput('enter');
    view.handleInput('down');
    view.handleInput('/');
    const narrowedRows = (text) => text.split('\n').filter((line) => /│ [▸ ] (alpha|beta|gamma) *│/.test(line));
    let body = strip(view.render(80).join('\n'));
    assert.equal(narrowedRows(body).length, 1, 'the kept query still filters to the single match');
    view.handleInput('\x7f');
    body = strip(view.render(80).join('\n'));
    assert.equal(narrowedRows(body).length, 1, 'DEL edits the kept query without host helpers');
    assert.ok(!/\x7f/i.test(body), 'the raw DEL byte never becomes visible query text');
    view.handleInput('\x7f');
    view.handleInput('\x7f');
    body = strip(view.render(80).join('\n'));
    assert.equal(narrowedRows(body).length, 3, 'emptying the query restores every document');
  });

  test('S10b: the association options are inert in the rendered frame', async () => {
    const calls = [];
    const opened = [];
    const plain = build();
    const gatedOff = build({
      assigned: ['odd/tasks/alpha.md'],
      assignmentEnabled: false,
      saveAssignment: (...args) => { calls.push(args); return { ok: true }; },
      openExternal: (target) => { opened.push(target); return { ok: true }; },
    });
    const expected = plain.view.render(80).join('\n');
    gatedOff.view.render(80);
    assert.equal(gatedOff.view.render(80).join('\n'), expected, 'no cell differs when the options are passed');
    const body = strip(gatedOff.view.render(80).join('\n'));
    const rows = body.split('\n').filter((line) => /│ [▸ ] (alpha|beta)( |$)/.test(line));
    assert.equal(rows.length, 2, 'both documents still list');
    assert.ok(rows.every((line) => !/[✓✎]/.test(line)), 'no assignment marks on the rows');
    assert.ok(!body.includes('unsaved'), 'no unsaved indicator');
    assert.ok(!body.includes('space'), 'no space hint');
    assert.ok(!body.includes('ctrl+s'), 'no save hint');
    assert.ok(!body.includes('assigned'), 'no assigned count');
    assert.match(body, /ctrl\+j\/k doc/, 'the scroll hint stays, naming the default pair');
    assert.match(body, /› Search/, 'the search row stays, without naming its key');
    assert.match(body, /o open/, 'the open hint stays');
    assert.match(body, /esc close/, 'the close hint stays');
    gatedOff.view.handleInput(' ');
    gatedOff.view.handleInput('\x13'); // ctrl+s
    await tick();
    assert.deepEqual(calls, [], 'Space and ctrl+s bytes never call the save callback');
    assert.ok(!strip(gatedOff.view.render(80).join('\n')).split('\n').some((line) => /✎ (alpha|beta)/.test(line)), 'no pending mark appears');
    gatedOff.view.handleInput('J');
    assert.ok(gatedOff.view.state.scroll > 0, 'scrolling still works with the options passed');
    gatedOff.view.handleInput('T');
    gatedOff.view.handleInput('a');
    gatedOff.view.handleInput('l');
    gatedOff.view.handleInput('enter');
    assert.match(strip(gatedOff.view.render(80).join('\n')).split('\n')[1], /› al( |$)/m, 'search still works');
    gatedOff.view.handleInput('o');
    await tick();
    assert.equal(opened.length, 1, 'the external open still works');
    gatedOff.view.handleInput('escape');
  });
});

// S2: the key legend is ONE terminal row — the keys the view gained (`T`
// filter, `o` open) ride the same row as the rest instead of a second one.
describe('S2: one-row key legends', () => {
  const WIDTHS = [40, 60, 80, 120];
  const tickOnce = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('the footer legend owns exactly one row at every width', async () => {
    for (const width of WIDTHS) {
      const { view } = makeView({
        docs: [doc('alpha'), doc('beta')],
        load: () => ({ ok: true, text: '# alpha\n\nbody of alpha\n' }),
      });
      await tickOnce();
      const lines = view.render(width).map(strip);
      assert.equal(lines.length, 20, `width ${width}: the frame fills the available rows`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `width ${width}: row is not ${width} wide`);
      const legend = lines.filter((line) => /esc close|o open/.test(line));
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /↑↓/, `width ${width}: the movement keys survive`);
      assert.match(legend[0], /esc close/, `width ${width}: the close key survives`);
    }
  });
});

// S13: the frame says each thing once. The document total lives in the title
// only, no chrome row repeats the focused document, the search key is named by
// the search row alone, and the escape hint belongs to the interaction the
// keyboard is in — while the box is open the footer names its keys once
// instead of the box and the footer both naming them.
describe('S13: the odd frame repeats nothing', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const footerOf = (lines) => lines[lines.length - 2];
  const tokensOf = (footer) => footer.split('·').map((token) => token.trim());

  function quietView({ docs = [doc('alpha'), doc('beta')], text = 'body line\n', rows = 20 } = {}) {
    return makeView({ docs, load: () => ({ ok: true, text }), rows }).view;
  }

  test('the document total renders once and no chrome row repeats the focused name', async () => {
    const view = quietView();
    await tick();
    const lines = strip(view.render(80).join('\n')).split('\n');
    const body = lines.join('\n');
    assert.equal((body.match(/documents?\b/g) || []).length, 1, `the total renders once: ${body}`);
    assert.equal((body.match(/alpha/g) || []).length, 1, 'the focused name appears in the list row only');
    assert.match(lines[0], /✎ Odd · 2 documents/, 'the title carries the one total');
  });

  test('the search key is named by the footer alone (S4 supersedes the earlier split)', async () => {
    const view = quietView();
    await tick();
    const lines = strip(view.render(120).join('\n')).split('\n');
    const footer = footerOf(lines);
    assert.match(lines[1], /› Search/, 'the search row carries the query only');
    assert.ok(!lines[1].includes('(T)'), 'no parenthetical key above the footer');
    assert.ok(tokensOf(footer).some((token) => /^t/.test(token)), `the footer names t: ${footer}`);
  });

  test('while searching the footer names the search keys once and the input carries only the query', async () => {
    const view = quietView();
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    const lines = strip(view.render(80).join('\n')).split('\n');
    const body = lines.join('\n');
    assert.match(lines[1], /› a█/, 'the input row carries the live query');
    assert.ok(!lines[1].includes('enter'), 'the input row repeats no key hint');
    assert.ok(!lines[1].includes('esc'), 'the input row names no escape key');
    const footer = footerOf(lines);
    assert.match(footer, /enter\/esc keep/, 'the footer names the search keys of this interaction');
    assert.ok(!footer.includes('esc close'), 'the close hint belongs to the reading interaction only');
    assert.ok(!footer.includes('ctrl+j/k'), 'the removed binding is never printed');
    assert.ok(!footer.includes('shift+j/k') && !footer.includes('ctrl+shift'), 'the scroll hints leave the footer while typing');
    assert.equal((body.match(/esc/g) || []).length, 1, `one escape hint for the current interaction: ${body}`);
    assert.equal((body.match(/enter/g) || []).length, 1, 'one enter hint for the current interaction');
  });

  test('leaving the box swaps the footer back and keeps a single escape hint', async () => {
    const view = quietView();
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('enter');
    const lines = strip(view.render(80).join('\n')).split('\n');
    const footer = footerOf(lines);
    assert.match(footer, /esc close/, 'the reading legend returns');
    assert.ok(!footer.includes('enter/esc keep'), 'the search keys leave with the box');
    assert.equal((lines.join('\n').match(/esc/g) || []).length, 1, 'still one escape hint');
  });

  test('the scroll position shares the search row instead of owning a second chrome row', async () => {
    const view = quietView({ docs: [doc('alpha')], text: longDoc(200) });
    await tick();
    view.handleInput('J');
    const lines = strip(view.render(80).join('\n')).split('\n');
    assert.equal(lines.length, 20, 'the frame still fills every row');
    assert.match(lines[1], /› Search/, 'the search widget rides the search row');
    assert.ok(!/page/i.test(lines[1]), 'the page marker is gone with the pager (S3)');
    assert.match(lines[1], / \d+\/\d+/, 'the reading position keeps the right edge');
    assert.ok(!/\d+-\d+\//.test(lines[1]), 'S10: no redundant start-of-window range');
    assert.equal(lines.length - 3, 20 - 3, 'the panes keep the rows the status row used to take');
  });
});

// ---------------------------------------------------------------------------
// worktree-ui-feedback T2/T5: S1 (real host input), S3/D3 (wrapped names and
// viewport-driven rows), S4 (every hint on the footer, Delete clears), S5
// ("para odd igual, si son muchas igual se pagina").
// ---------------------------------------------------------------------------
describe('createOddView feedback round (S1,S3,S4,S5,D3)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function build(opts = {}) {
    const paints = [];
    const view = createOddView({
      docs: opts.docs || [doc('alpha'), doc('beta')],
      loadDoc: opts.loadDoc || (() => ({ ok: true, text: longDoc(200) })),
      helpers: opts.helpers === undefined ? (realTui || helpers) : opts.helpers,
      theme: plainTheme,
      rowsAvailable: () => (opts.rows === undefined ? 20 : opts.rows),
      requestRender: () => { paints.push(true); },
      done: () => {},
      ...opts.rest,
    });
    return { view, paints };
  }

  const footerOf = (lines) => strip(lines[lines.length - 2]);
  const searchRowOf = (lines) => strip(lines[1]);
  const leftRows = (lines) => lines
    .slice(2, -2)
    .map((line) => strip(line).split('│')[1] || '');

  test('S1: ctrl+j/k scroll the preview, ctrl+shift+j/k stay an alternative, and the legacy ctrl+j byte does not', { skip: realTui ? false : 'requires @earendil-works/pi-tui' }, () => {
    // The installed 1.4 matcher reports the same 0x0a as BOTH `ctrl+j` and
    // `enter` while the Kitty protocol is inactive, which is the terminal the
    // user reported. That byte must stay Enter; only a payload the host can
    // tell apart from Enter pages.
    assert.equal(realTui.matchesKey('\n', 'ctrl+j'), true, 'the host byte is ctrl+j');
    assert.equal(realTui.matchesKey('\n', 'enter'), true, 'and the host also calls it enter');
    assert.equal(realTui.matchesKey('j', 'J'), true, 'the host matcher folds letter case, so the helper never asks it about a bare letter');
    const { view } = build();
    view.render(80);
    view.handleInput('\n');
    assert.equal(view.state.scroll, 0, 'the legacy ctrl+j byte never scrolls');
    view.handleInput('\x1b[106;5u'); // Kitty ctrl+j press
    assert.ok(view.state.scroll > 0, 'an extended ctrl+j scrolls where the host reports it');
    view.handleInput('\x1b[107;5u'); // Kitty ctrl+k press
    assert.equal(view.state.scroll, 0, 'the extended ctrl+k scrolls back');
    view.handleInput('\x1b[106;6u'); // Kitty ctrl+shift+j press
    assert.ok(view.state.scroll > 0, 'ctrl+shift+j scrolls the preview through the real matcher');
    view.handleInput('\x1b[107;6u'); // Kitty ctrl+shift+k press
    assert.equal(view.state.scroll, 0, 'ctrl+shift+k scrolls back');
    view.handleInput('\x0b');
    assert.equal(view.state.scroll, 0, 'the legacy control byte never scrolls');
    view.handleInput('\x1b[106;6:2u'); // Kitty ctrl+shift+j repeat
    assert.ok(view.state.scroll > 0, 'a Kitty key repeat also scrolls');
    view.handleInput('\x1b[106;6:3u'); // and its release does not
    const repeated = view.state.scroll;
    view.handleInput('\x1b[106;6:3u');
    assert.equal(view.state.scroll, repeated, 'a release never scrolls');
    assert.equal(view.state.index, 0, 'no scroll key moved the list selection');
  });

  test('S3: a long document list scrolls by the body budget, and ←/→ move the window', async () => {
    const docs = Array.from({ length: 14 }, (_, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    let lines = view.render(80);
    // rows 12 -> top rule + search row + footer + bottom rule = 8 body rows
    const firstWindow = leftRows(lines).filter((row) => row.trim() !== '');
    assert.equal(firstWindow.length, 8, 'every body row carries a document, no fixed page size');
    assert.match(firstWindow[0], /document-01/);
    assert.ok(!/page/i.test(searchRowOf(lines)), 'no page marker is printed');

    view.handleInput('right');
    lines = view.render(80);
    const secondWindow = leftRows(lines).filter((row) => row.trim() !== '');
    assert.equal(secondWindow.length, 8, 'the last window is kept full instead of half empty');
    assert.match(secondWindow[0], /document-07/, '→ starts the next screen after the last painted document');
    assert.equal(view.state.index, 6, 'the selection follows into the new screen');

    view.handleInput('left');
    assert.equal(view.state.listStart, 0, '← returns to the first document of the previous screen');
    assert.match(leftRows(view.render(80)).join(' '), /document-01/, 'the first screen paints again');
    view.handleInput('right');
    view.handleInput('right');
    assert.equal(view.state.listStart, 6, '→ stops at the last full window');
    view.handleInput('left');
    view.handleInput('left');
    assert.equal(view.state.listStart, 0, '← never scrolls before the first document');
  });

  test('S3: ↓ walks every document across window boundaries, skipping none', async () => {
    const docs = Array.from({ length: 14 }, (_, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    const seen = [];
    const windows = [];
    for (let step = 0; step < docs.length; step += 1) {
      const rendered = view.render(80);
      const rows = leftRows(rendered);
      const focused = rows.find((row) => row.includes('▸')) || '';
      seen.push((focused.match(/document-\d+/) || [''])[0]);
      windows.push(view.state.listStart);
      view.handleInput('down');
    }
    assert.deepEqual(seen, docs.map((entry) => entry.name.replace(/\.md$/, '')), 'every document is reachable in order');
    assert.equal(windows[0], 0, 'the first document starts the walk at the top of the list');
    assert.equal(windows.at(-1), 6, 'the last document ends the walk in the last full window');
    assert.deepEqual(windows, [...windows].sort((a, b) => a - b), 'the continuous window never jumps backwards');
  });

  test('S3: a long document name wraps over the rows it needs instead of truncating', async () => {
    const name = 'a-document-name-that-is-far-wider-than-the-list-pane';
    const { view } = build({ docs: [doc(name), doc('beta')], rows: 20, loadDoc: () => ({ ok: true, text: 'body\n' }) });
    await tick();
    const rows = leftRows(view.render(80)).map((row) => row.trim());
    const rendered = rows.join(' ');
    assert.ok(!rendered.includes('…'), `no ellipsis truncation: ${rendered}`);
    assert.ok(rendered.includes('wider'), 'the middle of the name is visible');
    assert.ok(rendered.includes('pane'), 'the end of the name is visible');
    assert.match(searchRowOf(view.render(80)), /› Search\b/, 'the search row still reads as the search widget');
  });

  test('S4: t is named by the footer only, and both cases open the box', async () => {
    const { view } = build();
    await tick();
    // S12 added one legend token, so the FULL spelling needs the wider row;
    // S14 replaced the page/half aliases with the ONE labelled document token,
    // so the compact tier now starts below 120.
    const lines = view.render(160);
    assert.equal(searchRowOf(lines).includes('(T)'), false, 'the search row names no key');
    assert.equal(searchRowOf(lines).includes('(t)'), false, 'in either case');
    assert.ok(!searchRowOf(lines).includes('T to edit'), 'leaving the box never re-adds the parenthetical key');
    assert.match(footerOf(lines), /t search/, 'the footer names the search key in lowercase');
    assert.match(footerOf(view.render(80)), /(^|· )t( ·|$)/, 'the compact legend still names the search key');
    view.handleInput('t');
    assert.equal(view.state.searching, true, 'lowercase t opens the search box');
    view.handleInput('a');
    const typing = view.render(80);
    assert.match(searchRowOf(typing), /› a█/, 'the input row carries the query only');
    assert.match(footerOf(typing), /del clear/, 'the footer advertises Delete while the box is open');
    assert.match(footerOf(typing), /bksp/, 'and Backspace for one character');
  });

  test('uppercase T keeps opening the search', async () => {
    const { view } = build();
    await tick();
    view.handleInput('T');
    assert.equal(view.state.searching, true, 'T still opens the box');
  });

  test('S4: Delete clears the whole query, Backspace deletes one character', async () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta'), doc('gamma')] });
    await tick();
    view.handleInput('T');
    for (const char of 'gam') view.handleInput(char);
    assert.equal(view.state.query, 'gam');
    view.handleInput('\x7f');
    assert.equal(view.state.query, 'ga', 'Backspace removes exactly one character');
    for (const char of 'mma') view.handleInput(char);
    assert.equal(leftRows(view.render(80)).filter((row) => row.includes('gamma')).length, 1, 'the query filters');
    view.handleInput('\x1b[3~'); // Delete
    assert.equal(view.state.query, '', 'Delete clears the entire query');
    assert.equal(view.state.searching, true, 'and leaves the box open for a new query');
    assert.equal(leftRows(view.render(80)).filter((row) => /document|alpha|beta|gamma/.test(row)).length, 3, 'every document lists again');
    for (const char of 'beta') view.handleInput(char);
    view.handleInput('delete'); // the host name for the same key
    assert.equal(view.state.query, '', 'the host key name clears it too');
  });

  test('D3: Tab stays out of the list; only ←/→ page and ↑↓/j/k select', async () => {
    const docs = Array.from({ length: 10 }, (_, at) => doc(`document-${at + 1}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    view.handleInput('tab');
    assert.equal(view.state.index, 0, 'Tab changes no selection in a single-dataset reader');
    assert.equal(view.state.scroll, 0);
    view.handleInput('down');
    assert.equal(view.state.index, 1, 'bare ↓ still moves the selection');
    view.handleInput('j');
    assert.equal(view.state.index, 2, 'bare j still moves the selection');
  });
});

// ---------------------------------------------------------------------------
// ui-consistency-round3 T3: S5 (shared 40/60 geometry, full titles), S8 (page
// capacity from the real rendered body and the wrapped row cost), S14 (page
// marker fixed next to Search on every page count) and S17 (hyphen-aware
// label wrapping). Every case drives the public render/handleInput surface
// only: no internal state is read except the documented `view.state` index.
// ---------------------------------------------------------------------------
describe('createOddView round-3 geometry, capacity and page marker (S5,S8,S14,S17)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const inner = (width) => layout.innerWidth(width);
  // S3: the ODD reader asks view-layout for the smaller 30% list share.
  const panes = (width) => layout.paneWidths(inner(width), { listShare: layout.READER_LIST_SHARE });
  const searchRowOf = (lines) => strip(lines[1]);
  const listCells = (lines) => lines.slice(2, -2).map((line) => strip(line).split('│')[1] || '');
  const filled = (lines) => listCells(lines).filter((row) => row.trim() !== '');

  function build({ docs, rows = 20, load } = {}) {
    const view = createOddView({
      docs,
      loadDoc: load || (() => ({ ok: true, text: 'body\n' })),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: () => {},
    });
    return { view };
  }

  const manyShort = (count) => Array.from({ length: count }, (_unused, at) => doc(`doc-${String(at + 1).padStart(2, '0')}`));
  const manyLong = (count) => Array.from({ length: count }, (_unused, at) => doc(`long-wrapped-document-name-number-${String(at + 1).padStart(2, '0')}`));

  test('S3: the two panes take the smaller 30/70 reader geometry at 200 and 80 columns', async () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    for (const width of [200, 80]) {
      const lines = view.render(width);
      const shared = panes(width);
      assert.ok(shared.right > shared.left, `${width}: the preview is wider than the list`);
      assert.equal(shared.left + shared.right + 3, inner(width), `${width}: the panes fill the inner width`);
      const row = strip(lines[2]);
      assert.equal([...row].indexOf('│', 2), 3 + shared.left, `${width}: the divider sits where the shared rule puts it`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `${width}: the frame fills the terminal`);
    }
  });

  test('S5: a full document name is reconstructible from its wrapped rows at 200 columns', async () => {
    const name = 'document-name-that-is-long-enough-to-need-several-wrapped-rows-in-the-list-pane';
    const { view } = build({ docs: [doc(name), doc('beta')] });
    await tick();
    const lines = view.render(200);
    const cost = layout.rowCost(helpers, name, panes(200).left, { first: '▸ ' });
    assert.equal(cost, 2, 'the name needs two rows in the widened list');
    const rows = listCells(lines).slice(0, cost).map((row) => row.slice(1).replace(/^[▸ ]{2}/, '').replace(/\s+$/, ''));
    assert.equal(rows.join(''), name, 'every character of the title survives the wrap');
  });

  test('S8: capacity is the real body rows divided by the rows each name needs, at 200 columns', async () => {
    const { view } = build({ docs: manyShort(30), rows: 20 });
    await tick();
    const first = view.render(200);
    assert.equal(listCells(first).length, 16, 'the body keeps every row the fixed chrome leaves');
    assert.equal(filled(first).length, 16, '16 one-row names fill the window at 200 columns');
    assert.ok(!/page/i.test(searchRowOf(first)), 'no page marker is printed (S3)');
    assert.match(filled(first)[0], /doc-01/);
    view.handleInput('right');
    const second = view.render(200);
    assert.equal(filled(second).length, 16, 'the next window is kept full');
    assert.match(filled(second)[0], /doc-15/, 'the next window starts after the last painted name');
    assert.equal(view.state.listStart, 14, 'a forward scroll stops at the last full window');
  });

  test('S8: taller wrapped names spend more of the same body budget', async () => {
    const docs = manyLong(12);
    const { view } = build({ docs, rows: 20 });
    await tick();
    const lines = view.render(64);
    const cost = layout.rowCost(helpers, docs[0].name, panes(64).left, { first: '▸ ' });
    assert.ok(cost >= 2, `each name wraps over several rows at this width, got ${cost}`);
    assert.equal(listCells(lines).length, 16, 'the body row budget does not depend on the wrap');
    assert.equal(filled(lines).length, Math.floor(16 / cost) * cost, 'a full window of wrapped names spends every body row');
    assert.equal(filled(lines).length / cost, Math.floor(16 / cost), 'the window carries whole names, never a fixed 20');
    assert.ok(!/page/i.test(searchRowOf(lines)), 'no page marker is printed (S3)');
  });

  test('S8: walking the window covers each label once, mixed one-row and two-row names included', async () => {
    const docs = Array.from({ length: 18 }, (_unused, at) => (at % 2 === 0
      ? doc(`short-name-${String(at + 1).padStart(2, '0')}`)
      : doc(`long-wrapped-document-name-number-${String(at + 1).padStart(2, '0')}`)));
    const { view } = build({ docs, rows: 20 });
    await tick();
    const walked = new Set();
    for (let guard = 0; guard < 40; guard += 1) {
      const rows = filled(view.render(64));
      assert.ok(rows.length <= 16, `window ${guard + 1}: never more rows than the body holds`);
      // Rows of one wrapped name are concatenated, so a name broken across rows
      // is still read whole.
      for (const token of rows.map((row) => row.trim()).join('').match(/name-(?:number-)?\d\d/g) || []) {
        walked.add(token.replace(/^name-(?:number-)?/, ''));
      }
      const before = view.state.listStart;
      view.handleInput('right');
      if (view.state.listStart === before) break;
    }
    assert.deepEqual(
      [...walked].sort(),
      Array.from({ length: 18 }, (_unused, at) => String(at + 1).padStart(2, '0')),
      'every document is reachable by scrolling the one window',
    );
  });

  test('S8: resizing re-windows around the selection and keeps it visible', async () => {
    const { view } = build({ docs: manyLong(40), rows: 20 });
    await tick();
    for (let step = 0; step < 20; step += 1) view.handleInput('down');
    assert.equal(view.state.index, 20);
    const wide = view.render(200);
    assert.ok(!/page/i.test(searchRowOf(wide)), 'one-row names at 200 columns print no page marker');
    assert.match(strip(filled(wide).find((row) => row.includes('▸'))), /number-21/, 'the selection is in the wide window');
    const narrow = view.render(64);
    const focused = filled(narrow).find((row) => row.includes('▸'));
    assert.ok(focused, 'the selection stays in the window after the resize');
    assert.match(strip(focused), /▸ long-wrapped-/, 'the focused name starts on the focused row');
    assert.ok(filled(narrow).join(' ').replace(/\s+/g, '').includes('name-number-21'), 'the focused document renders');
  });

  test('S8: a search that narrows the list keeps the focused row on the visible page', async () => {
    const { view } = build({ docs: manyShort(30), rows: 12 });
    await tick();
    for (let step = 0; step < 19; step += 1) view.handleInput('down');
    view.handleInput('T');
    view.handleInput('2');
    view.handleInput('enter');
    const lines = view.render(80);
    assert.match(searchRowOf(lines), /› 2/, 'the narrowed list keeps its query on the search row');
    assert.ok(!/page/i.test(searchRowOf(lines)), 'no page marker is printed (S3)');
    assert.equal(view.state.listStart, 0, 'the narrowed list starts at its own top');
    assert.match(strip(filled(lines).find((row) => row.includes('▸'))), /doc-02/, 'the selection restarts in the visible window');
  });

  test('S3: no page marker renders beside Search in any state', async () => {
    const single = build({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    assert.match(searchRowOf(single.view.render(120)), /› Search/, 'the widget keeps the row');
    assert.ok(!/page/i.test(searchRowOf(single.view.render(120))), 'a short list prints no marker');
    const empty = build({ docs: [] });
    await tick();
    assert.ok(!/page/i.test(searchRowOf(empty.view.render(120))), 'the empty list prints no marker');
    const noMatch = build({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    noMatch.view.handleInput('T');
    noMatch.view.handleInput('z');
    assert.match(searchRowOf(noMatch.view.render(120)), /› z█/, 'the query is still displayed');
    assert.ok(!/page/i.test(searchRowOf(noMatch.view.render(120))), 'a no-match query prints no marker');
    const narrow = build({ docs: [doc('alpha'), doc('beta')], rows: 12 });
    await tick();
    assert.ok(!/page/i.test(searchRowOf(narrow.view.render(24))), 'even the narrowest frame prints no marker');
  });

  test('S3: the frame carries no page marker at all, and the window moves instead', async () => {
    const docs = Array.from({ length: 14 }, (_unused, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    assert.ok(!/page \d+\/\d+/.test(strip(view.render(80).join('\n'))), 'nothing in the frame claims a page');
    assert.match(filled(view.render(80))[0], /document-01/);
    view.handleInput('right');
    assert.match(filled(view.render(80))[0], /document-07/, 'the window moved instead');
    assert.ok(!listCells(view.render(80)).some((row) => /page \d/.test(row)), 'the list content carries no page marker');
  });

  test('S17: the list breaks a hyphenated name at its hyphens, never inside a segment', async () => {
    const name = 'a-document-name-that-is-far-wider-than-the-list-pane';
    const { view } = build({ docs: [doc(name), doc('beta')] });
    await tick();
    const lines = view.render(80);
    const width = panes(80).left;
    const expected = layout.wrapLabel(helpers, name, width, { first: '▸ ', rest: '  ' });
    assert.ok(expected.length > 1, 'the name wraps over several rows');
    for (const row of expected) assert.ok(helpers.visibleWidth(row) <= width, `row too wide: ${row}`);
    assert.deepEqual(
      listCells(lines).slice(0, expected.length).map((row) => row.slice(1).replace(/\s+$/, '')),
      expected.map((row) => row.replace(/\s+$/, '')),
      'the rendered rows are the hyphen-aware wrap',
    );
    assert.ok(expected.some((row) => row.trimEnd().endsWith('-')), 'a break lands on a hyphen');
    assert.equal(expected.map((row) => row.replace(/^[▸ ]{2}/, '')).join(''), name, 'every character survives');
  });
});

// ---------------------------------------------------------------------------
// round-3 T3 S1: the preview scroll bindings ODD shares through
// lib/preview-scroll-keys.js. The default pair is ctrl+j/k — the one the user
// asked for, printed whatever the terminal reports — while ctrl+shift+j/k and
// the printable J/K stay working alternates whose hints leave the row. A bare
// LF byte is Enter on a legacy terminal and never pages.
// ---------------------------------------------------------------------------
describe('createOddView preview scroll bindings (S1)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const body200 = longDoc(200);
  const searchRowOf = (lines) => strip(lines[1]);
  const footerOf = (lines) => strip(lines[lines.length - 2]);

  // A host whose matcher/parser is a table of the payloads these tests send, so
  // each case states what the terminal reported instead of what the installed
  // module happens to decode.
  const TABLE = {
    '\x1b[6~': 'pageDown',
    '\x1b[5~': 'pageUp',
    '\x1b[106;6u': 'shift+ctrl+j',
    '\x1b[107;6u': 'shift+ctrl+k',
    '\x1b[27;6;106~': 'shift+ctrl+j',
    '\x1b[106;5u': 'ctrl+j',
    '\x1b[27;5;106~': 'ctrl+j',
    J: 'J',
    K: 'K',
    j: 'j',
    k: 'k',
    '\n': 'enter',
    '\x0b': 'ctrl+k',
    '\x04': 'ctrl+d',
  };
  const namesOf = (data) => (TABLE[data] ? [TABLE[data]] : []);
  const sameName = (a, b) => (a.length === 1 || b.length === 1 ? a === b : a.toLowerCase() === b.toLowerCase());
  function host({ kitty = false, partial = false } = {}) {
    const helpers = partial
      ? { matchesKey: (data, name) => namesOf(data).some((entry) => sameName(entry, name)) }
      : {
        isKittyProtocolActive: () => kitty,
        matchesKey: (data, name) => namesOf(data).some((entry) => sameName(entry, name)),
        parseKey: (data) => namesOf(data)[0] ?? null,
        isKeyRelease: (data) => /:3u$/.test(String(data)),
      };
    return helpers;
  }

  function build(kitchen = {}) {
    const paints = [];
    const view = createOddView({
      docs: [doc('alpha'), doc('beta')],
      loadDoc: () => ({ ok: true, text: body200 }),
      helpers: kitchen.helpers === undefined ? host() : kitchen.helpers,
      theme: plainTheme,
      rowsAvailable: () => 20,
      requestRender: () => { paints.push(true); },
      done: () => {},
    });
    return { view, paints };
  }

  test('the footer always names ctrl+j/k doc', async () => {
    for (const kitty of [true, false]) {
      const { view } = build({ helpers: host({ kitty }) });
      await tick();
      const footer = footerOf(view.render(120));
      assert.match(footer, /ctrl\+j\/k doc/, `kitty ${kitty}: the default pair is named with its target: ${footer}`);
      for (const gone of ['ctrl+shift', 'shift+j/k']) {
        assert.ok(!footer.includes(gone), `kitty ${kitty}: the alternate "${gone}" leaves the legend: ${footer}`);
      }
    }
    const cases = [
      ['unknown namespace', {}],
      ['no helpers', null],
      ['throwing getter', { isKittyProtocolActive: () => { throw new Error('no tty'); } }],
    ];
    for (const [label, helpers] of cases) {
      const { view } = build({ helpers });
      await tick();
      const footer = footerOf(view.render(120));
      assert.match(footer, /ctrl\+j\/k doc/, `${label}: the default pair is named with its target: ${footer}`);
      assert.ok(!footer.includes('ctrl+shift'), `${label}: no fabricated extended support: ${footer}`);
    }
  });

  test('PgUp/PgDn still page although S14 drops their generic token', async () => {
    // S14 supersedes the earlier legend: «alguna key generidad como el page o
    // half estan demas». The pair leaves the row because the labelled document
    // token already names what it moves — the BINDINGS are untouched.
    for (const kitty of [true, false]) {
      const { view } = build({ helpers: host({ kitty }) });
      await tick();
      const footer = footerOf(view.render(120));
      assert.ok(!/(PgUp|PgDn|PgUp\/Dn)/.test(footer), `kitty ${kitty}: no generic page token: ${footer}`);
      view.render(80);
      view.handleInput('\x1b[6~');
      const paged = view.state.scroll;
      assert.ok(paged > 1, `kitty ${kitty}: PageDown still pages the preview`);
      view.handleInput('\x1b[5~');
      assert.equal(view.state.scroll, 0, `kitty ${kitty}: PageUp still pages back`);
    }
  });

  test('ctrl+j/k page the preview where the host reports them, and a bare LF never does', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[106;5u');
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'ctrl+j pages the preview');
    view.handleInput('\x1b[107;5u');
    assert.equal(view.state.scroll, 0, 'ctrl+k pages back up');
    view.handleInput('\x1b[27;5;106~');
    assert.equal(view.state.scroll, paged, 'the xterm ctrl+j sequence pages too');
    view.handleInput('\x1b[27;5;107~');
    assert.equal(view.state.scroll, 0, 'and the xterm ctrl+k pages back');
    view.handleInput('\x1b[106;6u');
    assert.ok(view.state.scroll > 1, 'ctrl+shift+j stays a working alternative');
    view.handleInput('\x1b[107;6u');
    assert.equal(view.state.scroll, 0, 'ctrl+shift+k stays a working alternative');
    for (const data of ['\n', '\x0b']) {
      view.render(80);
      view.handleInput(data);
      assert.equal(view.state.scroll, 0, `${JSON.stringify(data)}: the legacy byte stays Enter, never a scroll`);
      assert.equal(view.state.index, 0, `${JSON.stringify(data)}: no selection movement either`);
    }
    assert.equal(view.state.index, 0);
  });

  test('the xterm modifyOtherKeys sequence pages and its release is ignored', async () => {
    const { view, paints } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[27;6;106~');
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'the xterm ctrl+shift+j sequence pages the preview');
    const before = paints.length;
    view.handleInput('\x1b[27;6;106;3~');
    assert.equal(view.state.scroll, paged, 'the release suffix never pages');
    assert.equal(paints.length, before, 'a release does not even repaint');
  });

  test('a repeat pages, a release never does', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[106;6:2u');
    const repeated = view.state.scroll;
    assert.ok(repeated > 1, 'a key repeat pages the preview');
    view.handleInput('\x1b[106;6:3u');
    assert.equal(view.state.scroll, repeated, 'the release of that key is ignored');
  });

  test('Enter and the LF byte keep their meaning even when the host calls the byte ctrl+j', async () => {
    const lfIsCtrlJ = {
      ...helpers,
      matchesKey: (data, name) => data === name || (data === '\n' && (name === 'enter' || name === 'ctrl+j')),
      parseKey: (data) => (data === '\n' ? 'ctrl+j' : null),
    };
    const { view, paints } = build({ helpers: lfIsCtrlJ });
    await tick();
    view.render(80);
    const before = paints.length;
    for (const data of ['\n', '\r', 'enter']) {
      view.handleInput(data);
      assert.equal(view.state.scroll, 0, `${JSON.stringify(data)}: Enter never scrolls`);
      assert.equal(view.state.index, 0, `${JSON.stringify(data)}: Enter never moves the selection`);
    }
    assert.equal(paints.length, before, 'Enter requests no repaint: nothing changed');
    view.handleInput('ctrl+j');
    assert.ok(view.state.scroll > 0, 'the distinguishable ctrl+j still pages the preview');
  });

  test('a search session keeps the scroll keys out of the preview', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.handleInput('T');
    view.handleInput('J');
    view.handleInput('\x1b[106;6u');
    assert.equal(view.state.query, 'J', 'the printable byte types into the query, it does not page');
    assert.equal(view.state.scroll, 0, 'no preview scroll while the box holds the keyboard');
    const lines = view.render(120);
    assert.match(searchRowOf(lines), /› J█/, 'the query row carries the typed letter');
    assert.match(footerOf(lines), /enter\/esc keep/, 'the footer names the search keys of this interaction');
    assert.ok(!footerOf(lines).includes('ctrl+shift'), 'the scroll hint leaves the footer while typing');
    view.handleInput('enter');
    assert.equal(view.state.query, 'J', 'leaving the box keeps the query');
    assert.equal(view.state.scroll, 0, 'still no scroll');
  });

  test('a partial helper namespace still pages through the shared fallback', async () => {
    const { view } = build({ helpers: host({ partial: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[6~');
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'PageDown works with a matcher-only host');
    view.handleInput('K');
    assert.equal(view.state.scroll, 0, 'the printable shift fallback works with a matcher-only host');
    view.handleInput('J');
    assert.equal(view.state.scroll, paged, 'and pages exactly what PageDown pages');
    view.handleInput('\x1b[106;6u');
    assert.ok(view.state.scroll > paged, 'the extended pair still resolves through the matcher');
  });

  test('the mouse wheel and the frame geometry are untouched by the binding change', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    const geometry = layout.paneWidths(layout.innerWidth(120), { listShare: layout.READER_LIST_SHARE });
    const lines = view.render(120);
    assert.equal(
      layout.paneWidths(layout.innerWidth(120), { listShare: layout.READER_LIST_SHARE }).left,
      geometry.left,
      'the 30/70 reader rule owns the panes',
    );
    assert.equal([...strip(lines[2])].indexOf('│', 2), 3 + geometry.left, 'the divider still sits at the shared column');
    view.handleMouse({ type: 'wheel', wheelDelta: 2 });
    assert.equal(view.state.scroll, 2, 'the wheel still scrolls the preview');
    assert.equal(view.state.index, 0, 'the wheel never moves the selection');
  });
});

// ---------------------------------------------------------------------------
// S14: «alguna key generidad como el page o half estan demas (nose para que
// es)» — the ODD footer names each scroll TARGET once, exactly like the issues
// reader: the document pane's page, half-page and printable hints collapse into
// the ONE labelled token the reader is always shown, and every binding still
// answers in the handler even after its hint leaves the row.
// ---------------------------------------------------------------------------
describe('createOddView footer scroll targets (S14)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const footerOf = (lines) => strip(lines[lines.length - 2]);
  const tokensOf = (footer) => footer.split('·').map((token) => token.trim()).filter((token) => token !== '');
  const body200 = longDoc(200);
  // The generic tokens the user reported as noise: a page pair and a half-page
  // pair nobody could place, next to a bare unlabelled `scroll`.
  const GENERIC = /(pgup|pgdn|half|ctrl\+d\/u)/i;

  // A host whose matcher is the payload table these tests drive, so every
  // binding assertion states what the terminal reported.
  function host(kitty) {
    return {
      isKittyProtocolActive: () => kitty,
      matchesKey: (data, name) => data === name,
      parseKey: (data) => data,
      isKeyRelease: () => false,
    };
  }

  function build({ kitty = true, theme = plainTheme, rows = 20, docs = [doc('alpha'), doc('beta')] } = {}) {
    return createOddView({
      docs,
      loadDoc: () => ({ ok: true, text: body200 }),
      helpers: host(kitty),
      theme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: () => {},
    });
  }

  test('the generic page and half tokens leave the footer in both tiers', async () => {
    for (const kitty of [true, false]) {
      const view = build({ kitty });
      await tick();
      for (const width of [80, 120]) {
        const footer = footerOf(view.render(width));
        assert.ok(!GENERIC.test(footer), `kitty ${kitty}/${width}: no generic page or half token: ${footer}`);
        assert.ok(!/\bscroll\b/.test(footer), `kitty ${kitty}/${width}: no bare unlabelled scroll token: ${footer}`);
      }
    }
  });

  test('the document pane is named once, by the default ctrl+j/k pair', async () => {
    const extended = build({ kitty: true });
    const printable = build({ kitty: false });
    await tick();
    const extendedFooter = footerOf(extended.render(120));
    const printableFooter = footerOf(printable.render(120));
    assert.match(extendedFooter, /ctrl\+j\/k doc/, `the default pair is named with its target: ${extendedFooter}`);
    assert.match(printableFooter, /ctrl\+j\/k doc/, `the same pair on a legacy terminal: ${printableFooter}`);
    for (const [label, footer] of [['extended', extendedFooter], ['fallback', printableFooter]]) {
      const docTokens = tokensOf(footer).filter((token) => /(^|\s)doc$/.test(token));
      assert.equal(docTokens.length, 1, `${label}: exactly one labelled document token: ${footer}`);
    }
  });

  test('S8: the list scroll pair has no footer token, and the document token keeps its target', async () => {
    const view = build();
    await tick();
    const footer = footerOf(view.render(120));
    assert.ok(!footer.includes('←/→'), `the redundant list scroll hint is gone: ${footer}`);
    assert.match(footer, /ctrl\+j\/k doc/, 'the document scroll keeps its labelled token');
    assert.match(footer, /s sort: recent/, 'the sort token stays beside the remaining scroll hint');
  });

  test('every document scroll binding still answers with its hint gone', async () => {
    const view = build({ kitty: true });
    await tick();
    view.render(80);
    view.handleInput('\x1b[6~');
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'PgDn still pages the document');
    view.handleInput('\x1b[5~');
    assert.equal(view.state.scroll, 0, 'PgUp still pages back');
    view.handleInput('J');
    assert.equal(view.state.scroll, paged, 'J pages exactly what PgDn pages');
    view.handleInput('K');
    assert.equal(view.state.scroll, 0, 'K pages back');
    view.handleInput('\x04');
    const half = view.state.scroll;
    assert.ok(half > 0 && half < paged, `ctrl+d keeps the half-page step: ${half} of ${paged}`);
    view.handleInput('\x15');
    assert.equal(view.state.scroll, 0, 'ctrl+u returns half a page up');
    view.handleInput('\x1b[106;6u');
    assert.equal(view.state.scroll, paged, 'ctrl+shift+j pages the document');
    view.handleInput('\x1b[107;6u');
    assert.equal(view.state.scroll, 0, 'ctrl+shift+k pages back');
    view.handleInput('end');
    assert.ok(view.state.scroll > 0, 'end still jumps to the bottom');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0, 'home still returns to the top');
    assert.equal(view.state.index, 0, 'no document scroll key ever moved the list');
  });

  test('the list scroll keys keep working with no footer token', async () => {
    const names = Array.from({ length: 30 }, (_unused, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));
    const view = build({ docs: names, rows: 12 });
    await tick();
    const firstCells = (lines) => lines.slice(2, -2).map((line) => strip(line).split('│')[1] || '').filter((cell) => cell.trim() !== '');
    const first = () => firstCells(view.render(80))[0];
    assert.match(first(), /document-01/, 'the window starts at the first document');
    view.handleInput(']');
    assert.match(first(), /document-09/, '] moves the window a screen forward');
    view.handleInput('[');
    assert.match(first(), /document-01/, '[ moves it back');
    view.handleInput('right');
    assert.match(first(), /document-09/, '→ scrolls the list like ]');
    view.handleInput('left');
    assert.match(first(), /document-01/, '← scrolls the list like [');
  });

  test('the one-row legend keeps the key/description roles at every width', async () => {
    for (const width of [40, 60, 80, 120]) {
      const view = build({ theme: recordingTheme() });
      await tick();
      const lines = view.render(width);
      const legend = lines.map(strip).filter((line) => /esc close|o open/.test(line));
      assert.equal(legend.length, 1, `${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /esc close/, `${width}: the close key survives`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `${width}: rows stay ${width} wide`);
    }
    const view = build({ theme: recordingTheme(), kitty: true });
    await tick();
    const footer = view.render(160).at(-2);
    assert.match(footer, /\x1b\[1m\x1b\[96mctrl\+j\/k\x1b\[0m\x1b\[22m\x1b\[90m doc/,
      'the document hint paints its key accent+bold and its target muted');
    assert.match(footer, /\x1b\[1m\x1b\[96mr\x1b\[0m\x1b\[22m\x1b\[90m reload/,
      'the reload hint keeps the key/description split');
    assert.ok(!strip(footer).includes('←/→'), 'S8: the list scroll pair is not painted at all');
  });
});

// S3 (T3): the ODD reader drops the page marker and becomes a continuous list.
// The left pane is the smaller 30% share, ←/→ scroll the list a screenful at a
// time, and the focused document always stays inside the painted window — the
// filter keeps working over the whole list and no document is skipped.
describe('createOddView continuous list scrolling instead of pages (S3)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const readerPanes = (width) => layout.paneWidths(layout.innerWidth(width), { listShare: layout.READER_LIST_SHARE });
  const searchRowOf = (lines) => strip(lines[1]);
  const footerOf = (lines) => strip(lines[lines.length - 2]);
  const listCells = (lines) => lines.slice(2, -2).map((line) => strip(line).split('│')[1] || '');
  const filled = (lines) => listCells(lines).filter((row) => row.trim() !== '');
  const names = (count) => Array.from({ length: count }, (_unused, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));

  function build({ docs = names(2), rows = 20 } = {}) {
    const view = createOddView({
      docs,
      loadDoc: () => ({ ok: true, text: 'body\n' }),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: () => {},
    });
    return view;
  }

  test('the left pane takes the smaller 30/70 share', async () => {
    const view = build({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    for (const width of [80, 120, 200]) {
      const lines = view.render(width);
      const expected = readerPanes(width).left;
      assert.equal([...strip(lines[2])].indexOf('│', 2), 3 + expected, `${width}: the list is ${expected} cells`);
      assert.ok(expected < layout.paneWidths(layout.innerWidth(width)).left, `${width}: narrower than the old 40% list`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `${width}: the frame fills the terminal`);
    }
  });

  test('no page marker renders on the search row in any state', async () => {
    const many = build({ docs: names(30), rows: 12 });
    await tick();
    assert.ok(!/page/i.test(searchRowOf(many.render(80))), 'a long list prints no page marker');
    const single = build({ docs: [doc('alpha')] });
    await tick();
    assert.ok(!/page/i.test(searchRowOf(single.render(120))), 'a one-document list prints no marker');
    const empty = build({ docs: [] });
    await tick();
    assert.ok(!/page/i.test(searchRowOf(empty.render(120))), 'the empty state prints no marker');
    const narrow = build({ docs: names(30), rows: 12 });
    await tick();
    assert.ok(!/page/i.test(searchRowOf(narrow.render(24))), 'the narrowest frame prints no marker');
  });

  test('the footer names no page key', async () => {
    const view = build({ docs: names(30), rows: 12 });
    await tick();
    const footer = footerOf(view.render(200));
    assert.ok(!/page/i.test(footer), `the legend drops the page hint: ${footer}`);
    assert.ok(!footer.includes('←/→'), `S8: the list scroll pair costs no cells: ${footer}`);
    assert.match(footer, /ctrl\+j\/k doc/, 'the document scroll is named once with its target');
  });

  test('a long list scrolls continuously: one screen at a time', async () => {
    const view = build({ docs: names(30), rows: 12 });
    await tick();
    // 12 rows leave 8 body rows, so the first window paints documents 1..8.
    const first = filled(view.render(80));
    assert.equal(first.length, 8, 'every body row carries a document');
    assert.match(first[0], /document-01/);
    assert.ok(!first.join(' ').includes('document-09'), 'the rest of the list is below the window');
    view.handleInput('right');
    const second = filled(view.render(80));
    assert.match(second[0], /document-09/, '→ starts the next screen after the last painted document');
    assert.ok(!second.join(' ').includes('document-01'), 'the previous screen scrolled away');
    view.handleInput('left');
    assert.match(filled(view.render(80))[0], /document-01/, '← scrolls back to the first screen');
    view.handleInput('left');
    assert.match(filled(view.render(80))[0], /document-01/, '← never scrolls before the first document');
  });

  test('the selection walks past the window edge and the list follows it', async () => {
    const view = build({ docs: names(20), rows: 12 });
    await tick();
    for (let step = 0; step < 8; step += 1) view.handleInput('down');
    assert.equal(view.state.index, 8, 'the ninth document is focused');
    const rows = filled(view.render(80));
    assert.ok(!rows.join(' ').includes('document-01'), 'the window scrolled past the first document');
    assert.ok(rows.some((row) => /▸ document-09/.test(row)), 'the focused document is painted at the window edge');
  });

  test('every document stays reachable in order across the window moves', async () => {
    const docs = names(18);
    const view = build({ docs, rows: 12 });
    await tick();
    const seen = [];
    for (let step = 0; step < docs.length; step += 1) {
      const rows = filled(view.render(80));
      const focused = rows.find((row) => row.includes('▸')) || '';
      seen.push((focused.match(/document-\d+/) || [''])[0]);
      view.handleInput('down');
    }
    assert.deepEqual(seen, docs.map((entry) => entry.name), 'every document is focused once, in order');
  });

  test('the filter still narrows the whole list and keeps the focused document visible', async () => {
    const view = build({ docs: names(30), rows: 12 });
    await tick();
    for (let step = 0; step < 19; step += 1) view.handleInput('down');
    view.handleInput('T');
    view.handleInput('2');
    view.handleInput('enter');
    const rows = filled(view.render(80));
    assert.match(searchRowOf(view.render(80)), /› 2/, 'the query is kept on the search row');
    assert.match(rows.find((row) => row.includes('▸')) || '', /document-02/, 'the selection restarts on a visible document');
    assert.ok(rows.length > 0, 'the narrowed list paints its rows');
  });

  test('the preview scroll position still rides the right edge of the search row', async () => {
    const view = createOddView({
      docs: [doc('alpha')],
      loadDoc: () => ({ ok: true, text: longDoc(200) }),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => 20,
      requestRender: () => {},
      done: () => {},
    });
    await tick();
    view.handleInput('J');
    const row = searchRowOf(view.render(80));
    assert.match(row, /› Search/, 'the search widget owns the left of the row');
    assert.match(row, / \d+\/\d+/, 'the reading position keeps the right edge');
    assert.ok(!/\d+-\d+\//.test(row), 'S10: the reading position carries no range prefix');
  });
});

// ---------------------------------------------------------------------------
// S11: every footer token paints through the injected theme with a role that
// distinguishes a shortcut KEY from its description, and the header paints its
// title accent+bold, its separator dim and its count muted.
describe('odd view palette (S11)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function paletteView(theme, docs = [doc('alpha'), doc('beta')]) {
    return createOddView({
      docs,
      loadDoc: (entry) => ({ ok: true, text: `# ${entry.name}\n\n## Specs\nS1. first rule\n` }),
      helpers,
      theme,
      rowsAvailable: () => 20,
      requestRender: () => {},
      done: () => {},
    });
  }

  test('the footer paints every shortcut key accent+bold and its description muted', async () => {
    const theme = recordingTheme();
    const view = paletteView(theme);
    await tick();
    const footer = view.render(160).at(-2);
    assert.match(footer, /\x1b\[1m\x1b\[96m↑↓\x1b\[0m\x1b\[22m/, 'the key token is painted accent+bold');
    assert.match(footer, /\x1b\[90m select/, 'its description is painted muted');
    assert.match(footer, /\x1b\[1m\x1b\[96mctrl\+j\/k\x1b\[0m\x1b\[22m/, 'the document scroll key is a key run');
    assert.match(footer, /\x1b\[1m\x1b\[96mt\x1b\[0m\x1b\[22m/, 'a single-letter key is painted the same way');
    assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === '↑↓'),
      'the accent role comes from the injected theme');
    assert.ok(theme.calls.some((call) => call.role === 'bold' && call.text.includes('↑↓')),
      'the key is bolded through the theme, never by a literal escape');
    assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text.includes('select')),
      'the description asks the injected theme for the muted role');
  });

  test('the search legend uses the same key/description split', async () => {
    const theme = recordingTheme();
    const view = paletteView(theme);
    await tick();
    view.handleInput('T');
    const footer = view.render(160).at(-2);
    assert.match(footer, /\x1b\[1m\x1b\[96mtype\x1b\[0m\x1b\[22m\x1b\[90m to filter/,
      'the typing hint paints its key accent+bold and its description muted');
    assert.match(footer, /\x1b\[1m\x1b\[96mbksp\x1b\[0m\x1b\[22m/, 'backspace keeps the same pair');
  });

  // T9 (S13): the frame title takes `customMessageLabel`, the role the Pi Agents
  // view paints its own frame title with, while the footer's keys
  // keep the PRIMARY accent — so a title and a button never read as the same
  // control. The document's markdown heading keeps its own `mdHeading` role.
  test('the header paints the title with the reference dim title role, its separator dim and the count muted', async () => {
    const theme = recordingTheme();
    const view = paletteView(theme);
    await tick();
    const lines = view.render(120);
    assert.match(lines[0], /\x1b\[1m\x1b\[33m✎ Odd\x1b\[0m\x1b\[22m/,
      'the frame title is the dim role, bold');
    assert.ok(theme.calls.some((call) => call.role === 'customMessageLabel' && call.text === '✎ Odd'),
      'the title asks the injected theme for the title role');
    assert.ok(!theme.calls.some((call) => call.role === 'accent' && call.text === '✎ Odd'),
      'the title never competes with the primary accent a button uses');
    assert.match(lines[0], /\x1b\[2m · \x1b\[0m/, 'the separator is the dim label role');
    assert.match(lines[0], /\x1b\[90m2 documents\x1b\[0m/, 'the document count is muted, never accent');
    // The right-pane document title is the markdown heading, painted through the
    // injected theme with its own heading role plus bold — never a hardcoded SGR.
    assert.ok(theme.calls.some((call) => call.role === 'mdHeading'),
      'the document title keeps its own heading role');
    const titleCall = theme.calls.find((call) => call.role === 'mdHeading');
    assert.match(titleCall.text, /^\x1b\[1m/, 'the document title is bolded through the theme');
  });

  test('a hostile theme never breaks the frame and keeps the keys and focus readable', async () => {
    const hostile = {
      fg() { throw new Error('no colour support'); },
      bold() { throw new Error('no bold support'); },
      bg() { throw new Error('no background support'); },
    };
    const view = paletteView(hostile);
    await tick();
    // 160 keeps the full-spelling legend tier (S12 added one token).
    const body = strip(view.render(160).join('\n'));
    assert.match(body, /✎ Odd · 2 documents/, 'the header still renders without colour');
    assert.match(body, /↑↓ select/, 'the footer still names the key and its description');
    assert.match(body, /▸ alpha/, 'the focused document keeps its mark, so focus survives monochrome');
    assert.match(body, /› Search/, 'the search widget still renders');
  });

  // T9 (S13): text the reader typed is ordinary text, not the accent a button
  // owns — the selected row stays told apart by its own band instead.
  test('the search row paints its label dim and its live value as ordinary text', async () => {
    const theme = recordingTheme();
    const view = paletteView(theme);
    await tick();
    const idle = view.render(120)[1];
    assert.match(idle, /\x1b\[2m› \x1b\[0m\x1b\[2mSearch/, 'the idle search widget is dim, never accent');
    view.handleInput('T');
    for (const char of 'alp') view.handleInput(char);
    const live = view.render(120)[1];
    assert.match(live, /\x1b\[2m› \x1b\[0m/, 'the prompt keeps the dim label role while typing');
    assert.match(live, /\x1b\[39malp/, 'the live query value is the theme text role');
    assert.ok(!/\x1b\[96malp/.test(live), 'the typed value is never the button accent');
  });
});

// ---------------------------------------------------------------------------
// S12: the list shows the most recently modified document first — the order
// lib/odd-docs.js already returns — and ONE shortcut alternates it with a
// case-insensitive alphabetical order. The focused document survives the
// toggle, the visible window re-anchors on it, the name filter composes with
// both orders, and the ONE footer legend names the key and the active order.
describe('createOddView list order (S12)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const listCells = (lines) => lines.slice(2, -2).map((line) => strip(line).split('│')[1] || '');
  const filled = (lines) => listCells(lines).filter((cell) => cell.trim() !== '');
  const rowName = (cell) => cell.trim().replace(/^▸\s*/, '');
  const namesOf = (lines) => filled(lines).map(rowName);
  const focusedName = (lines) => {
    const cell = filled(lines).find((entry) => entry.includes('▸'));
    return cell === undefined ? null : rowName(cell);
  };
  const footerOf = (lines) => strip(lines[lines.length - 2]);
  const searchRowOf = (lines) => strip(lines[1]);

  // The loader's own order: most recently modified first, never alphabetical.
  const RECENT = [doc('mike'), doc('alpha'), doc('Zulu'), doc('bravo')];

  function build({ docs = RECENT, rows = 20, theme = plainTheme, reloadDocs } = {}) {
    const paints = [];
    const view = createOddView({
      docs,
      loadDoc: (entry) => ({ ok: true, text: `# ${entry.name}\n\nbody of ${entry.name}\n` }),
      reloadDocs,
      helpers,
      theme,
      rowsAvailable: () => rows,
      requestRender: () => { paints.push(true); },
      done: () => {},
    });
    return { view, paints };
  }

  test('the list defaults to the loader order, newest modified first', async () => {
    const { view } = build();
    await tick();
    const lines = view.render(80);
    assert.deepEqual(namesOf(lines), ['mike', 'alpha', 'Zulu', 'bravo'], 'the loader order is kept, never re-sorted');
    assert.equal(focusedName(lines), 'mike', 'the first (most recent) document is focused');
    assert.match(footerOf(view.render(160)), /s sort: recent/, 'the footer names the order key and the active order');
  });

  test('s alternates between newest-first and case-insensitive alphabetical order', async () => {
    const { view, paints } = build();
    await tick();
    const before = paints.length;
    view.handleInput('s');
    assert.ok(paints.length > before, 'the toggle requests a repaint');
    let lines = view.render(80);
    assert.deepEqual(namesOf(lines), ['alpha', 'bravo', 'mike', 'Zulu'], 'alphabetical and case-insensitive');
    assert.equal(focusedName(lines), 'mike', 'the focused document rides the toggle');
    assert.match(footerOf(view.render(160)), /s sort: name/, 'the footer names the alphabetical order once it is active');
    view.handleInput('s');
    lines = view.render(80);
    assert.deepEqual(namesOf(lines), ['mike', 'alpha', 'Zulu', 'bravo'], 'the second toggle returns the loader order');
    assert.equal(focusedName(lines), 'mike');
    assert.match(footerOf(view.render(160)), /s sort: recent/);
  });

  test('the focused document stays focused across the toggle, in both directions', async () => {
    const { view } = build();
    await tick();
    view.handleInput('down');
    assert.equal(focusedName(view.render(80)), 'alpha', 'alpha is focused in the loader order');
    view.handleInput('s');
    let lines = view.render(80);
    assert.equal(focusedName(lines), 'alpha', 'the same document is focused in the alphabetical order');
    assert.equal(view.state.index, 0, 'its new position is the focused index');
    assert.match(strip(lines.join('\n')), /body of alpha/, 'the reading pane still shows the same document');
    view.handleInput('s');
    lines = view.render(80);
    assert.equal(focusedName(lines), 'alpha', 'and again on the way back');
    assert.equal(view.state.index, 1, 'back in its loader position');
  });

  test('a toggle re-anchors the visible window on the focused document', async () => {
    // The loader order is the reverse of the alphabetical one.
    const docs = Array.from({ length: 20 }, (_unused, at) => doc(`item-${String(20 - at).padStart(2, '0')}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    let lines = view.render(80);
    assert.equal(namesOf(lines)[0], 'item-20', 'the most recent document starts the window');
    assert.equal(focusedName(lines), 'item-20');
    view.handleInput('s');
    lines = view.render(80);
    assert.equal(focusedName(lines), 'item-20', 'the focused document stays focused');
    assert.equal(namesOf(lines).at(-1), 'item-20', 'the window moved to its alphabetical position at the end of the list');
    assert.ok(!namesOf(lines).includes('item-01'), 'the window no longer starts at the top of the list');
    assert.equal(filled(lines).length, 8, 'the window is kept full');
    view.handleInput('s');
    lines = view.render(80);
    assert.equal(namesOf(lines)[0], 'item-20', 'the window returns to the top with the loader order');
    assert.equal(focusedName(lines), 'item-20');
  });

  test('the order toggle composes with the name filter', async () => {
    const { view } = build({ docs: [doc('maple'), doc('alpha'), doc('bravo'), doc('cherry')] });
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('enter');
    let lines = view.render(80);
    assert.match(searchRowOf(lines), /› a( |$)/m, 'the query stays on the search row');
    assert.deepEqual(namesOf(lines), ['maple', 'alpha', 'bravo'], 'the filter keeps the loader order of its matches');
    view.handleInput('s');
    lines = view.render(80);
    assert.deepEqual(namesOf(lines), ['alpha', 'bravo', 'maple'], 'the filtered matches sort alphabetically');
    assert.match(searchRowOf(lines), /› a( |$)/m, 'the toggle keeps the filter');
    assert.equal(focusedName(lines), 'maple', 'the focused match stays focused');
    view.handleInput('s');
    assert.deepEqual(namesOf(view.render(80)), ['maple', 'alpha', 'bravo'], 'and back to the loader order of the matches');
  });

  test('s types into the open filter box instead of toggling the order', async () => {
    const { view } = build({ docs: [doc('maple'), doc('alpha'), doc('bravo')] });
    await tick();
    view.handleInput('T');
    view.handleInput('s');
    assert.match(searchRowOf(view.render(80)), /› s█/, 'the letter goes into the query');
    view.handleInput('\x7f');
    view.handleInput('enter');
    assert.deepEqual(namesOf(view.render(80)), ['maple', 'alpha', 'bravo'], 'the order never toggled while typing');
    assert.match(footerOf(view.render(160)), /s sort: recent/);
  });

  test('a reload keeps the chosen order', async () => {
    let current = [doc('mike'), doc('alpha'), doc('Zulu')];
    const { view } = build({ docs: current, reloadDocs: () => ({ ok: true, docs: current }) });
    await tick();
    view.handleInput('s');
    current = [doc('mike'), doc('alpha'), doc('Zulu'), doc('bravo')];
    view.handleInput('r');
    await tick();
    assert.deepEqual(namesOf(view.render(80)), ['alpha', 'bravo', 'mike', 'Zulu'], 'the reloaded list keeps the alphabetical order');
    assert.match(strip(view.render(80).join('\n')), /4 documents/);
  });

  test('the footer names the sort key with the key/description roles, on ONE row', async () => {
    const { view } = build({ theme: recordingTheme() });
    await tick();
    let footer = view.render(160).at(-1 - 1);
    assert.match(footer, /\x1b\[1m\x1b\[96ms\x1b\[0m\x1b\[22m\x1b\[90m sort: recent/, 'the key is accent+bold, its description muted');
    view.handleInput('s');
    footer = view.render(160).at(-2);
    assert.match(footer, /\x1b\[1m\x1b\[96ms\x1b\[0m\x1b\[22m\x1b\[90m sort: name/, 'the description names the new order');

    const plain = build();
    await tick();
    for (const width of [40, 60, 80, 120]) {
      const lines = plain.view.render(width);
      const legend = lines.map(strip).filter((line) => /esc close|o open/.test(line));
      assert.equal(legend.length, 1, `${width}: the legend owns exactly one row`);
      assert.ok(!legend[0].includes('…'), `${width}: compacted, never ellipsis-clipped`);
      // S14: the labelled document token is four cells longer than the bare
      // pair it replaced, so at the narrowest width the sort key is the entry
      // the one-row budget drops first. From 60 up both spellings survive: the
      // compact `s` while the row still compacts, the full one once it fits.
      if (width >= 60 && width < 120) assert.match(legend[0], /(^|· )s( ·|$)/, `${width}: the sort key survives the compaction`);
      if (width >= 120) assert.match(legend[0], /s sort: recent/, `${width}: the full spelling names the sort key and the order`);
      assert.equal(lines.length, 20, `${width}: the frame still fills the rows`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `${width}: rows stay ${width} wide`);
    }
  });
});

// ---------------------------------------------------------------------------
// worktree-issues-reliability T6 (S8,S9,S10), all through the public
// render/handleInput surface:
//   S8 «salen flecha izq/der ... esta bien el atajo pero demas marcarlo» — the
//   list scroll pair keeps working and leaves the footer;
//   S9 «el r en odd no hace nada pareceria» — a reload that changes no row must
//   still say it ran, re-read the open document, and name a failure;
//   S10 «pagina/linea ... sale el 1-, esta demas» — the reading position keeps
//   the useful numbers and loses the range prefix.
// ---------------------------------------------------------------------------
describe('createOddView shortcut round (S8,S9,S10)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const footerOf = (lines) => strip(lines[lines.length - 2]);
  const searchRowOf = (lines) => strip(lines[1]);
  const bodyOf = (lines) => strip(lines.join('\n'));
  const listCells = (lines) => lines.slice(2, -2).map((line) => strip(line).split('│')[1] || '');
  const filled = (lines) => listCells(lines).filter((cell) => cell.trim() !== '');
  const names = (count) => Array.from({ length: count }, (_unused, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));

  function build({ docs = [doc('alpha'), doc('beta')], rows = 20, load, reloadDocs } = {}) {
    return createOddView({
      docs,
      loadDoc: load || (() => ({ ok: true, text: longDoc(200) })),
      reloadDocs,
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: () => {},
    });
  }

  test('S8: the footer no longer marks the list scroll pair, and ←/→ keep scrolling the list', async () => {
    const view = build({ docs: names(14), rows: 12 });
    await tick();
    const footer = footerOf(view.render(80));
    assert.ok(!footer.includes('←/→'), `the redundant list hint is gone: ${footer}`);
    assert.ok(!/→\s*list/.test(footer), 'no list scroll token anywhere in the footer');
    assert.match(footer, /esc close/, 'the rest of the legend survives');
    const first = () => filled(view.render(80))[0];
    assert.match(first(), /document-01/, 'the window starts at the first document');
    view.handleInput('right');
    assert.match(first(), /document-07/, '→ still moves the list one screenful');
    view.handleInput('left');
    assert.match(first(), /document-01/, '← still moves it back');
    view.handleInput(']');
    assert.match(first(), /document-07/, '] still moves it forward');
    view.handleInput('[');
    assert.match(first(), /document-01/, '[ still moves it back');
  });

  test('S9: r names its outcome on the footer, so a reload that changes nothing is not silent', async () => {
    const same = [doc('alpha'), doc('beta')];
    const view = build({ reloadDocs: () => ({ ok: true, docs: same }) });
    await tick();
    const before = footerOf(view.render(80));
    assert.match(before, / r( |$)/, 'the idle footer still names the key');
    view.handleInput('r');
    await tick();
    const after = footerOf(view.render(80));
    assert.match(after, /r reloaded/, `the footer says the reload happened: ${after}`);
    assert.notEqual(after, before, 'the reload is visible even when nothing else changed');
  });

  test('S9: r re-reads the focused document, so an edit on disk reaches the pane', async () => {
    let text = '# alpha\n\nfirst body\n';
    const view = build({
      docs: [doc('alpha')],
      load: () => ({ ok: true, text }),
      reloadDocs: () => ({ ok: true, docs: [doc('alpha')] }),
    });
    await tick();
    assert.match(bodyOf(view.render(80)), /first body/);
    text = '# alpha\n\nsecond body\n';
    view.handleInput('r');
    await tick();
    const body = bodyOf(view.render(80));
    assert.match(body, /second body/, 'the reloaded pane shows the edited document');
    assert.ok(!body.includes('first body'), 'the stale body is gone');
  });

  test('S9: a failing reload keeps the list and reports the failure instead of doing nothing', async () => {
    const view = build({ reloadDocs: () => ({ ok: false, reason: 'no-checkout', docs: [] }) });
    await tick();
    view.handleInput('r');
    await tick();
    const lines = view.render(80);
    assert.match(bodyOf(lines), /alpha/, 'the documents stay listed');
    assert.match(footerOf(lines), /(^|· )r failed( ·|$)/, `the failure is named in the footer: ${footerOf(lines)}`);
  });

  // S9 at the reported width: the reader who saw `r` in the compact legend and
  // then reloaded is on a ~60-column terminal. The idle token fits there, so the
  // outcome must fit too instead of being pruned away as if nothing happened.
  test('S9: the reload outcome stays in the compact legend at 60 columns, where the idle r fits', async () => {
    for (const kitty of [null, true, false]) {
      const label = kitty === null ? 'fallback helpers' : `kitty ${kitty}`;
      const same = [doc('alpha'), doc('beta')];
      const make = (reloadDocs) => {
        const localHelpers = kitty === null
          ? helpers
          : { ...helpers, isKittyProtocolActive: () => kitty };
        return createOddView({
          docs: [doc('alpha'), doc('beta'), ...names(8)],
          loadDoc: () => ({ ok: true, text: longDoc(120) }),
          reloadDocs,
          helpers: localHelpers,
          theme: plainTheme,
          rowsAvailable: () => 12,
          requestRender: () => {},
          done: () => {},
        });
      };
      const idle = make(() => ({ ok: true, docs: same }));
      const footer = footerOf(idle.render(60));
      assert.match(footer, /(^|· )r( ·|$)/, `${label}: the premise — an idle r token fits at 60: ${footer}`);
      assert.match(footer, /esc close/, `${label}: close survives at 60`);

      const ok = make(() => ({ ok: true, docs: same }));
      ok.handleInput('r');
      await tick();
      const after = footerOf(ok.render(60));
      assert.match(after, /(^|· )r reloaded( ·|$)/, `${label}: the successful outcome is visible at 60: ${after}`);
      assert.match(after, /esc close/, `${label}: close survives the larger token: ${after}`);

      const failing = make(() => ({ ok: false }));
      failing.handleInput('r');
      await tick();
      const failedFooter = footerOf(failing.render(60));
      assert.match(failedFooter, /(^|· )r failed( ·|$)/, `${label}: the failure is visible at 60: ${failedFooter}`);
      assert.match(failedFooter, /esc close/, `${label}: close survives the failure token: ${failedFooter}`);
    }
  });

  test('S9: the compact legend keeps the keys working once the outcome token is painted', async () => {
    const localHelpers = { ...helpers, isKittyProtocolActive: () => true };
    let closed = 'pending';
    const view = createOddView({
      docs: names(14),
      loadDoc: () => ({ ok: true, text: longDoc(40) }),
      reloadDocs: () => ({ ok: true, docs: names(14) }),
      helpers: localHelpers,
      theme: plainTheme,
      rowsAvailable: () => 12,
      requestRender: () => {},
      done: (result) => { closed = result; },
    });
    view.handleInput('r');
    await tick();
    assert.match(footerOf(view.render(60)), /r reloaded/, 'the preview frame is the reported 60-column one');
    const first = () => filled(view.render(60))[0];
    assert.match(first(), /document-01/, 'the window starts at the first document');
    view.handleInput('right');
    assert.match(first(), /document-07/, '→ still moves the list a screen under the outcome token');
    view.handleInput('left');
    assert.match(first(), /document-01/, '← still moves it back');
    view.handleInput('escape');
    assert.equal(closed, null, 'esc still closes the view');
  });

  test('S10: the reading position names the visible-through line and the total, with no 1- prefix', async () => {
    const view = build({ docs: [doc('alpha')] });
    await tick();
    const top = searchRowOf(view.render(80));
    assert.match(top, / 16\/399( |$)/, `the row shows the visible-through line and the total: ${top}`);
    assert.ok(!/\d+-\d+\//.test(top), `no redundant range prefix: ${top}`);
    view.handleInput('J');
    const paged = searchRowOf(view.render(80));
    assert.match(paged, / 31\/399( |$)/, `the position moves with the document: ${paged}`);
    assert.ok(!/\d+-\d+\//.test(paged), 'and the range never comes back');
  });
});

// ---------------------------------------------------------------------------
// S21 («se traba»): the /odd view can be handed its list in TWO steps — the
// interactive open paints the cheap local scan at once, and the git-ranked
// order lands when the checkout's history walk answers. `applyDocs` is that
// second step, and it has to behave like the `s` order toggle rather than like
// a reload: the focused document survives by IDENTITY (the reader keeps
// reading the same file while the list settles), the window re-anchors on its
// new position, and no document is re-read because only the order changed.
// ---------------------------------------------------------------------------
describe('createOddView two-step listing (S21)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const listCells = (lines) => lines.slice(2, -2).map((line) => strip(line).split('│')[1] || '');
  const filled = (lines) => listCells(lines).filter((cell) => cell.trim() !== '');
  const rowName = (cell) => cell.trim().replace(/^▸\s*/, '');
  const namesOf = (lines) => filled(lines).map(rowName);
  const focusedName = (lines) => {
    const cell = filled(lines).find((entry) => entry.includes('▸'));
    return cell === undefined ? null : rowName(cell);
  };
  const bodyOf = (lines) => strip(lines.join('\n'));

  function build({ docs, rows = 20, load } = {}) {
    const reads = [];
    const paints = [];
    const view = createOddView({
      docs,
      loadDoc: (entry) => {
        reads.push(entry.name);
        return { ok: true, text: `# ${entry.name}\n\nbody of ${entry.name}\n` };
      },
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => { paints.push(true); },
      done: () => {},
    });
    return { view, reads, paints };
  }

  test('a re-ranked list keeps the focused document and its already-rendered pane', async () => {
    const { view, reads, paints } = build({ docs: [doc('bravo'), doc('alpha'), doc('mike')] });
    await tick();
    view.render(80);
    view.handleInput('down');
    view.handleInput('down');
    const before = view.render(80);
    assert.equal(focusedName(before), 'mike', 'the premise: mike is the focused document');
    const readsBefore = reads.slice();

    const paintsBefore = paints.length;
    view.applyDocs([doc('mike'), doc('alpha'), doc('bravo')]);
    assert.ok(paints.length > paintsBefore, 'applying the settled order requests a repaint');

    const after = view.render(80);
    assert.deepEqual(namesOf(after), ['mike', 'alpha', 'bravo'], 'the list takes the new sequence');
    assert.equal(focusedName(after), 'mike', 'the reader keeps the SAME document, not the same index');
    assert.match(bodyOf(after), /body of mike/, 'the pane still shows the document being read');
    assert.deepEqual(reads, readsBefore, 'only the order moved, so no document is read again');
  });

  test('the applied order keeps the selection inside the list when a document disappears', async () => {
    const { view } = build({ docs: [doc('alpha'), doc('bravo'), doc('charlie')] });
    await tick();
    view.handleInput('down');
    view.handleInput('down');
    assert.equal(focusedName(view.render(80)), 'charlie');
    // The checkout changed under the reader: charlie is gone from the settled
    // listing, so the selection clamps instead of pointing past the end.
    view.applyDocs([doc('alpha'), doc('bravo')]);
    const lines = view.render(80);
    assert.deepEqual(namesOf(lines), ['alpha', 'bravo']);
    assert.ok(view.state.index <= 1, `the selection stays inside the list: ${view.state.index}`);
    assert.match(bodyOf(lines), /body of bravo/, 'and it lands on the last document instead of nothing');
  });

  test('an apply that carries nothing usable leaves the open list exactly as it was', async () => {
    const { view } = build({ docs: [doc('alpha'), doc('bravo')] });
    await tick();
    view.handleInput('down');
    const before = view.render(80);
    view.applyDocs(undefined);
    view.applyDocs(null);
    const after = view.render(80);
    assert.deepEqual(namesOf(after), namesOf(before), 'an absent answer never empties the list');
    assert.equal(focusedName(after), focusedName(before), 'and never moves the reader');
  });

  test('a two-step open still shows the whole first list and closes on esc', async () => {
    let closed = 'pending';
    const view = createOddView({
      docs: [doc('alpha'), doc('beta')],
      loadDoc: () => ({ ok: true, text: '# alpha\n' }),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => 20,
      requestRender: () => {},
      done: (result) => { closed = result; },
    });
    const first = view.render(80);
    assert.match(bodyOf(first), /✎ Odd · 2 documents/, 'the cheap first frame already counts the documents');
    assert.deepEqual(namesOf(first), ['alpha', 'beta'], 'and already lists them');
    view.handleInput('escape');
    assert.equal(closed, null, 'esc still closes the view');
  });
});

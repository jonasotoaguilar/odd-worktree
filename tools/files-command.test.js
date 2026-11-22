'use strict';
// T7 (S9, S14, S17) and T10 (S20, S27): the `/files` command driven through the
// registered handler and the fake host. The interactive panels themselves have
// their own suites (tools/files-picker-view.test.js,
// tools/files-scope-view.test.js); what this file proves is the COMMAND: that it
// is registered with the other four, that a host without an overlay gets one
// honest line instead of a throw, and that it wires the landed modules — the two
// scope lists from Git and the ownership rule, the picker with its
// `loadEntries`/`loadPreview`/`highlight`/`languageForPath` seams, the insertion
// form through `pasteToEditor`, and the editor handoff that stops the terminal,
// forces one full repaint on the close path and disposes its view (S14, S27).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { LIB_DIR, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');

const scratch = [];
function track(dir) {
  scratch.push(dir);
  return dir;
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

/** A real repository: `main`, one commit and one tracked file. */
function makeRepo() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-files-repo-')));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'a.js', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return fs.realpathSync(dir);
}

/** One checkout this package owns, at the canonical directory, one file short of committed. */
function addOwnedWorktree(repo, odd, branch) {
  const parent = path.dirname(repo);
  const target = path.join(parent, `${path.basename(repo)}-worktrees`, odd);
  git(repo, ['worktree', 'add', '-b', branch, target, 'main']);
  fs.writeFileSync(path.join(target, 'x.js'), 'const y = 2;\n');
  return fs.realpathSync(target);
}

/**
 * S20: a checkout Git knows that this package never created, so it is on the `a`
 * list and not on the registered one. Its parent is realpath'd first, so the path
 * Git records is the path the picker paints.
 */
function addLooseWorktree(repo, name, branch) {
  const parent = track(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-files-loose-wt-'))));
  const target = path.join(parent, name);
  git(repo, ['worktree', 'add', '-b', branch, target, 'main']);
  fs.writeFileSync(path.join(target, 'loose.js'), 'const loose = 1;\n');
  return target;
}

// ---- the fake host -------------------------------------------------------
//
// One extension instance per load, because `setFilesTuiLoader` and
// `setFilesAgentLoader` are that instance's own seams (the same shape the other
// panels' tests use). `custom` mounts the factory exactly like Pi does: the
// component is built synchronously and the answer resolves the overlay promise.
async function loadFilesExtension(pi = {}) {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-files-ext-')));
  const copy = path.join(dir, 'odd-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbedSource());
  const mod = await import(pathToFileURL(copy).href);
  const commands = new Map();
  const fakeHost = {
    registerCommand: (name, handler) => { commands.set(name, handler); },
    registerTool: () => {},
    registerMessageRenderer: () => {},
    on: () => {},
    ...pi,
  };
  mod.default(fakeHost);
  return { mod, commands };
}

const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: (text) => text };

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * The mount host: records every `custom` call (its options and its component) and
 * every terminal event the handoff causes, so a test can tell what the command
 * asked for and what it repainted.
 */
function mountHost({ rows = 40 } = {}) {
  const mounts = [];
  const events = [];
  const renders = [];
  const pasted = [];
  const notifications = [];
  const tui = {
    terminal: { rows },
    stopped: false,
    stops: [],
    stop(options) { tui.stopped = true; events.push('stop'); tui.stops.push(options); },
    start() { tui.stopped = false; events.push('start'); },
    // Pi records the request even while stopped: `requestRender(true)` resets the
    // written-frame state at once and defers only the paint, which is how the
    // next frame after `start()` rewrites every cell (S27). `renders` keeps the
    // terminal state each request was made in, so a test can tell whether the
    // paint was asked for while the terminal was still ours.
    requestRender(force) {
      renders.push({ force: force === true, stopped: tui.stopped });
      events.push(force === true ? 'render:force' : 'render');
    },
  };
  const ui = {
    notify: (text, level) => { notifications.push([level, text]); },
    pasteToEditor: (text) => { pasted.push(text); },
    custom: (factory, options) => new Promise((resolve) => {
      const component = factory(tui, theme, {}, (value) => resolve(value));
      mounts.push({ options, component });
    }),
  };
  return { tui, mounts, events, renders, pasted, notifications, ui };
}

/**
 * The session ctx. `registeredRoots` are the worktrees this session registered
 * through the host's `session_worktree_register` tool: the host appends one
 * custom entry per registration, which is the only durable record of them
 * (S35), so the double carries the same shape instead of a seam of its own.
 */
function ctxFor(repo, ui, options = {}) {
  const sessionId = options.sessionId === undefined ? 'thread-1' : options.sessionId;
  const registeredRoots = Array.isArray(options.registeredRoots) ? options.registeredRoots : [];
  return {
    cwd: repo,
    hasUI: true,
    mode: 'tui',
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => registeredRoots.map((root) => ({
        type: 'custom',
        customType: 'gentle-pi.session-worktree/v1',
        data: { sessionId, root, evidence: 'session:tool' },
      })),
    },
    ui,
  };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const rowsOf = (component, width = 120) => component.render(width).map((line) => stripAnsi(line));
const textOf = (component, width = 120) => rowsOf(component, width).join('\n');
// A scope row reads `│ ▸ <label> [±n files] │`; counting them is how a
// duplicated `main` row would be caught. The detail line and the footer share the
// frame but never reduce to a label plus a count cell.
const scopeLabels = (component) => rowsOf(component)
  .filter((row) => row.startsWith('│ ') && row.endsWith(' │'))
  .map((row) => row.slice(2, -2).replace(/\s+/g, ' ').trimStart().replace(/^▸ /, '').trim());
const scopeRowCount = (component, label) => scopeLabels(component)
  .filter((row) => row === label
    || (row.startsWith(`${label} ±`) && /^±\d+ files?$/.test(row.slice(label.length + 1)))).length;

// The ANSI-aware helpers the panel measures with; key matching falls back to the
// view's own spelled sequences, which is what a host without `matchesKey` has.
function visibleWidthOf(value) {
  return [...stripAnsi(value)].length;
}

const helpers = {
  visibleWidth: visibleWidthOf,
  truncateToWidth: (value, width, ellipsis = '') => {
    const text = stripAnsi(value);
    if (width <= 0) return '';
    const chars = [...text];
    if (chars.length <= width) return value;
    const mark = [...String(ellipsis)];
    return `${chars.slice(0, Math.max(0, width - mark.length)).join('')}${mark.join('')}`;
  },
  // ANSI-aware: a line that already fits keeps its escapes, which is what the
  // coloured preview depends on. A longer one is split on visible cells.
  wrapTextWithAnsi: (value, width) => {
    if (width <= 0) return [String(value)];
    if (visibleWidthOf(value) <= width) return [String(value)];
    const chars = [...stripAnsi(value)];
    const rows = [];
    while (chars.length > width) rows.push(chars.splice(0, width).join(''));
    rows.push(chars.join(''));
    return rows;
  },
  isKeyRelease: () => false,
  // What Pi's own matcher does for the keys this test drives: a raw sequence
  // becomes a name. Without it the panels only see the names themselves.
  matchesKey: (data, name) => {
    const RAW = {
      '\u001b[A': 'up', '\u001b[B': 'down', '\r': 'enter', '\n': 'enter',
      '\u001b': 'escape', '\t': 'tab', '\u0005': 'ctrl+e', '\u000f': 'ctrl+o',
      '\u0015': 'ctrl+u', '\u000a': 'ctrl+j',
    };
    return data === name || RAW[data] === name;
  },
};

const GREEN = '\u001b[32m';

// Pi's own pair, faked: a `.js` file is coloured and every other name is not.
const agentStub = {
  highlightCode: (code, language) => {
    const lines = String(code).split('\n');
    return language === 'javascript' ? lines.map((line) => `${GREEN}${line}\u001b[39m`) : lines;
  },
  getLanguageFromPath: (filePath) => (filePath.endsWith('.js') ? 'javascript' : undefined),
};

describe('/files registration (S17)', () => {
  test('the file picker is registered beside the other three panels', async () => {
    const { commands } = await loadExtension({});
    assert.deepEqual([...commands.keys()].sort(), ['depth', 'files', 'issues', 'odd', 'warp']);
    const files = commands.get('files');
    assert.equal(typeof files.handler, 'function', 'the command carries its handler');
    assert.ok(files.description.includes('files'), 'the description says what it browses');
    assert.ok(files.description.includes('ctrl+e'), 'and how a file opens in the editor');
  });

  test('the command reads the seven landed files modules and nothing of its own', () => {
    const source = stubbedSource();
    assert.ok(source.includes('pi.registerCommand(\'files\''), 'the command is registered');
    assert.ok(source.includes('function registerFilesCommand'), 'its registration is a named step');
    for (const module of [
      'files-index.js',
      'files-insert.js',
      'files-scope-detail.js',
      'files-scope-view.js',
      'files-picker-view.js',
    ]) {
      assert.ok(source.includes(`libRequire('${module}')`), `${module} is required by the wiring`);
    }
    // The row builder and the preview pane are composed BY the views, so the
    // command must own no copy of their rules.
    assert.equal(/function (buildRows|nextOrder|previewRows)\b/.test(source), false, 'the wiring reimplements no view rule');
  });
});

describe('a host without an overlay (S17)', () => {
  test('says so in one honest line and returns', async () => {
    const { commands } = await loadExtension({});
    const notifications = [];
    const ctx = { cwd: os.tmpdir(), ui: { notify: (text, level) => notifications.push([level, text]) } };
    await commands.get('files').handler('', ctx);
    assert.deepEqual(notifications, [['info', 'files: the file picker needs an interactive session with overlay support']]);
  });

  test('a host with no UI at all, and one whose UI throws, never throws into the host', async () => {
    const { commands } = await loadExtension({});
    await commands.get('files').handler('', { cwd: os.tmpdir() });
    const hostile = {
      cwd: os.tmpdir(),
      ui: {
        notify: () => { throw new Error('dead UI'); },
      },
    };
    await commands.get('files').handler('', hostile);
  });

  test('an argument is refused instead of opening the picker', async () => {
    const { commands } = await loadExtension({});
    const notifications = [];
    const ctx = { cwd: os.tmpdir(), ui: { notify: (text, level) => notifications.push([level, text]) } };
    await commands.get('files').handler('nope', ctx);
    assert.deepEqual(notifications, [['error', 'Unknown option "nope". Use /files with no argument.']]);
  });

  test('outside a Git repository the package’s own sentence lands', async () => {
    const { commands } = await loadExtension({});
    const loose = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-files-loose-')));
    const host = mountHost();
    await commands.get('files').handler('', ctxFor(loose, host.ui));
    assert.deepEqual(host.mounts, [], 'no overlay is mounted over nothing');
    assert.deepEqual(host.notifications, [['info', `not a git repository: ${fs.realpathSync(loose)}; run 'git init' first`]]);
  });
});

describe('one checkout: the scope step still opens (S20, S7/S8)', () => {
  test('the step offers the session checkout alone, and Enter pastes its `@` reference', async () => {
    const repo = makeRepo();
    const { commands } = await loadFilesExtension();
    const host = mountHost();
    // The overlay resolves `ctx.ui.custom` only when it settles, so the handler is
    // started and driven, never awaited before the panel answers.
    const running = commands.get('files').handler('', ctxFor(repo, host.ui));

    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    assert.equal(host.mounts.length, 1, 'the step opens even when there is nothing else to choose (S20)');
    assert.deepEqual(host.mounts[0].options, {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' },
    }, 'the step is its own smaller card');
    const step = host.mounts[0].component;
    const stepRows = textOf(step);
    assert.ok(stepRows.includes('main'), 'the session checkout is the row');
    assert.ok(!stepRows.includes('±'), 'a clean checkout paints no count');
    assert.ok(stepRows.includes('a all'), 'the footer names the list `a` switches to (S20)');

    step.handleInput('enter');

    await waitFor(() => host.mounts.length >= 2, 'the picker mount');
    assert.deepEqual(host.mounts[1].options, {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '85%', minWidth: 76, maxHeight: '100%' },
    }, 'the picker takes the terminal width S15 needs');

    const picker = host.mounts[1].component;
    await waitFor(() => textOf(picker).includes('a.js'), 'the listing');
    // The order footer and the one-option-per-key legend are the view's; the
    // command only has to hand it a listing to paint.
    // S33 (round L11) renamed the flat order `modified` to `files`; the footer
    // token is the view's, and this line only proves the wiring gave it a listing.
    assert.ok(textOf(picker).includes('files'), 'the default order paints');

    // The default `files` order puts changed files first and sorts the clean
    // ones by path, so the highlight opens on README.md, not on a.js.
    picker.handleInput('\r');
    assert.deepEqual(host.pasted, ['@README.md'], 'the session checkout keeps the `@` form');
    assert.deepEqual(host.notifications, [], 'inserting never notifies');
    await running;
  });
});

describe('the `a` list of every worktree (S20)', () => {
  test('`a` offers a worktree this package never registered, and it is browsable', async () => {
    const repo = makeRepo();
    const loose = addLooseWorktree(repo, 'loose', 'feat/loose');
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    const host = mountHost();
    const running = commands.get('files').handler('', ctxFor(repo, host.ui));

    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    const step = host.mounts[0].component;
    assert.ok(!textOf(step).includes('loose · feat/loose'), 'the registered list does not carry it');
    assert.ok(textOf(step).includes('a all'));

    step.handleInput('a');
    const widened = textOf(step);
    assert.ok(widened.includes('loose · feat/loose'), 'Git\'s own listing offers it under the same label');
    assert.ok(widened.includes('a registered'), 'and the footer names the way back');

    step.handleInput('\u001b[B');
    step.handleInput('\r');

    await waitFor(() => host.mounts.length >= 2, 'the picker over the loose checkout');
    const picker = host.mounts[1].component;
    await waitFor(() => textOf(picker).includes('loose.js'), 'the loose checkout listing');
    assert.ok(textOf(picker).includes(loose), 'the picker lists the checkout the step answered');

    const disposeOnce = picker.dispose.bind(picker);
    let disposed = 0;
    picker.dispose = () => { disposed += 1; disposeOnce(); };
    picker.handleInput('\u001b');
    await running;
    assert.equal(disposed, 1, 'a close that never reached the editor still disposes its view (S27)');
  });
});

describe('the default scope list is the session’s (S35)', () => {
  test('main, the session checkout and the registered worktrees; an unregistered ODD worktree needs `a`', async () => {
    const repo = makeRepo();
    const registered = addOwnedWorktree(repo, 'registered-one', 'feat/reg');
    addOwnedWorktree(repo, 'owned-only', 'feat/only');
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    const host = mountHost();
    const running = commands.get('files').handler('', ctxFor(repo, host.ui, { registeredRoots: [registered] }));

    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    const step = host.mounts[0].component;
    assert.ok(textOf(step).includes('main'), 'the principal checkout leads');
    assert.ok(textOf(step).includes('registered-one · feat/reg'), 'the session’s registration is a default row');
    assert.ok(textOf(step).includes('±1 file'), 'and it keeps its uncommitted count');
    assert.ok(!textOf(step).includes('owned-only · feat/only'),
      'an ODD worktree this session never registered is not a default row');
    assert.ok(textOf(step).includes('a all'), 'the footer names the list `a` switches to');
    assert.equal(scopeRowCount(step, 'main'), 1, '`main` is one row');

    step.handleInput('a');
    assert.ok(textOf(step).includes('owned-only · feat/only'), '`a` is what shows every worktree Git reports');
    assert.ok(textOf(step).includes('registered-one · feat/reg'), 'and it still carries the registered one');
    assert.ok(textOf(step).includes('a registered'), 'the footer names the way back');
    assert.equal(scopeRowCount(step, 'main'), 1, '`main` is never duplicated on the wider list');

    step.handleInput('a');
    assert.ok(!textOf(step).includes('owned-only · feat/only'), 'the key switches back to the session’s list');
    assert.ok(textOf(step).includes('registered-one · feat/reg'));

    // The step answers the scope object the picker then browses.
    step.handleInput('\u001b[B');
    step.handleInput('\r');
    await waitFor(() => host.mounts.length >= 2, 'the picker over the registered worktree');
    const picker = host.mounts[1].component;
    await waitFor(() => textOf(picker).includes('x.js'), 'the registered worktree’s listing');
    assert.ok(textOf(picker).includes(registered), 'the picker lists the checkout the step answered');
    picker.handleInput('\u001b');
    await running;
  });

  test('a session that registered nothing sees `main` alone, and `a` still works', async () => {
    const repo = makeRepo();
    addOwnedWorktree(repo, 'owned-only', 'feat/only');
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    const host = mountHost();
    const running = commands.get('files').handler('', ctxFor(repo, host.ui));

    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    const step = host.mounts[0].component;
    assert.equal(scopeRowCount(step, 'main'), 1, 'the session checkout IS `main`, so it is one row');
    assert.ok(!textOf(step).includes('owned-only · feat/only'), 'no registration, no default row for it');
    assert.ok(textOf(step).includes('a all'));

    step.handleInput('a');
    assert.ok(textOf(step).includes('owned-only · feat/only'), 'the wider list still works with nothing registered');
    assert.ok(textOf(step).includes('a registered'));
    step.handleInput('a');
    assert.ok(!textOf(step).includes('owned-only · feat/only'), 'and the way back is the one row');
    assert.equal(scopeRowCount(step, 'main'), 1);

    step.handleInput('\u001b');
    await running;
  });

  test('a session sitting in another worktree carries it, once, without registering anything', async () => {
    const repo = makeRepo();
    const mine = addOwnedWorktree(repo, 'mine', 'feat/mine');
    addOwnedWorktree(repo, 'other', 'feat/other');
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    const host = mountHost();
    const running = commands.get('files').handler('', ctxFor(mine, host.ui));

    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    const step = host.mounts[0].component;
    assert.ok(textOf(step).includes('main'), '`main` leads from any checkout');
    assert.equal(scopeRowCount(step, 'mine · feat/mine'), 1, 'the session’s own checkout is one row');
    assert.ok(!textOf(step).includes('other · feat/other'), 'a worktree the session neither sits in nor registered is not');

    step.handleInput('a');
    assert.ok(textOf(step).includes('other · feat/other'), '`a` reports every worktree of the clone');
    assert.equal(scopeRowCount(step, 'mine · feat/mine'), 1, 'and the session checkout is still one row');
    assert.equal(scopeRowCount(step, 'main'), 1);
    step.handleInput('\u001b');
    await running;
  });
});

describe('several checkouts: the scope step (S9)', () => {
  test('main first with the worktree’s count and detail, then the picker over the chosen checkout', async () => {
    const repo = makeRepo();
    const worktree = addOwnedWorktree(repo, 'pick-me', 'feat/pick');
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    const host = mountHost();
    // S35: the default list carries the worktrees THIS SESSION registered, so the
    // checkout is registered here exactly as `worktree_create` registers it; the
    // `a` list (every worktree Git reports) has its own case below.
    const running = commands.get('files').handler('', ctxFor(repo, host.ui, { registeredRoots: [worktree] }));

    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    const scopeMount = host.mounts[0];
    assert.deepEqual(scopeMount.options, {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' },
    }, 'the step is its own smaller card');
    const scopeRows = textOf(scopeMount.component);
    assert.ok(scopeRows.includes('main'), 'the principal checkout leads');
    assert.ok(scopeRows.includes('pick-me · feat/pick'), 'the worktree names its ODD and its branch');
    assert.ok(scopeRows.includes('±1 file'), 'its uncommitted count is read from Git');
    assert.ok(scopeRows.includes('init'), 'the detail line leads with the last commit subject');
    assert.ok(scopeRows.indexOf('main') < scopeRows.indexOf('pick-me'), 'main keeps the first row');

    // Down selects the worktree, Enter opens it.
    scopeMount.component.handleInput('\u001b[B');
    scopeMount.component.handleInput('\r');

    await waitFor(() => host.mounts.length >= 2, 'the picker over the chosen scope');
    const picker = host.mounts[1].component;
    await waitFor(() => textOf(picker).includes('x.js'), 'the worktree listing');
    assert.ok(textOf(picker).includes(worktree), 'the picker names the scope it lists');

    picker.handleInput('\r');
    assert.deepEqual(host.pasted, [path.join(worktree, 'x.js')], 'another checkout travels as its real absolute path');
    assert.deepEqual(host.notifications, []);
    await running;
  });

  test('esc closes the step without opening a picker', async () => {
    const repo = makeRepo();
    addOwnedWorktree(repo, 'pick-me', 'feat/pick');
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    const host = mountHost();
    const running = commands.get('files').handler('', ctxFor(repo, host.ui));
    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    host.mounts[0].component.handleInput('\u001b');
    await running;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(host.mounts.length, 1, 'nothing else is mounted');
    assert.deepEqual(host.pasted, []);
  });
});

describe('the preview and the editor (S12, S14)', () => {
  test('the injected highlighter reaches the pane through the command’s own seams (S12)', async () => {
    const repo = makeRepo();
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    mod.setFilesAgentLoader(async () => agentStub);
    const host = mountHost();
    const running = commands.get('files').handler('', ctxFor(repo, host.ui));
    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    host.mounts[0].component.handleInput('enter');
    await waitFor(() => host.mounts.length >= 2, 'the picker mount');
    const picker = host.mounts[1].component;
    const painted = () => picker.render(120).join('\n');
    await waitFor(() => textOf(picker).includes('a.js'), 'the listing');
    // The highlight follows the HIGHLIGHTED row: the order opens on README.md,
    // which names no language, so the file with the language is selected first.
    assert.equal(painted().includes(GREEN), false, 'a language-less file stays plain');
    picker.handleInput('\u001b[B');
    await waitFor(() => painted().includes(GREEN), 'the coloured preview');
    assert.ok(stripAnsi(painted()).includes('const x = 1;'), 'the file text is the preview');
    picker.handleInput('\u001b');
    await running;
  });

  test('ctrl+e settles the overlay on a live terminal, then stops it for the editor, and disposes once it returns (S27)', async () => {
    const repo = makeRepo();
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    const { mod, commands } = await loadFilesExtension();
    mod.setFilesTuiLoader(async () => helpers);
    const host = mountHost();
    const running = commands.get('files').handler('', ctxFor(repo, host.ui));
    await waitFor(() => host.mounts.length >= 1, 'the scope mount');
    host.mounts[0].component.handleInput('enter');
    await waitFor(() => host.mounts.length >= 2, 'the picker mount');
    const picker = host.mounts[1].component;
    await waitFor(() => textOf(picker).includes('a.js'), 'the listing');

    // The view the command constructed is the component the host was handed, so
    // its `dispose` calls are observable on the very object the factory returned.
    const disposeOnce = picker.dispose.bind(picker);
    let disposed = 0;
    picker.dispose = () => { disposed += 1; disposeOnce(); };

    host.events.length = 0;
    host.renders.length = 0;
    picker.handleInput('\u0005');
    // The reference's order: the overlay settles and the forced close repaint
    // lands while the terminal is STILL ours; only then is it stopped for the
    // editor. `ctl+e` records the path in `onOpen`, it never spawns from there.
    assert.deepEqual(host.events, ['render:force'], 'the close path repaints BEFORE anything stops the terminal');
    assert.deepEqual(host.renders, [{ force: true, stopped: false }], 'and that repaint is the forced one, on a live terminal');
    assert.equal(host.tui.stopped, false, 'the terminal is still ours when the overlay settles');

    await waitFor(() => host.events.includes('start'), 'the terminal resumed after the editor step');
    assert.equal(host.tui.stopped, false);
    assert.deepEqual(host.events, ['render:force', 'stop', 'start', 'render:force'],
      'stop arrives after the settle, and the resume repaint is the second forced one');
    assert.deepEqual(host.tui.stops, [{ preserveScreen: true }],
      'the suspend preserves the screen: a bare stop stamps the whole alt-screen frame into scrollback');
    assert.deepEqual(host.renders, [
      { force: true, stopped: false },
      { force: true, stopped: false },
    ], 'the resume repaint is asked for once the terminal is back');
    await waitFor(() => disposed === 1, 'the view disposed once the handoff returned');
    await running;
    assert.equal(disposed, 1, 'disposed exactly once');
    assert.deepEqual(host.notifications, [[
      'warning',
      'files: no editor configured: set $VISUAL or $EDITOR to open documents outside Pi',
    ]]);
    assert.deepEqual(host.pasted, [], 'opening a file pastes nothing');
  });
});

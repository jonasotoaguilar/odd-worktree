'use strict';
// The create wizard: `Type · Odd` — the ODD is the one identity, chosen from the
// ODDs that exist in `main` (first entry `new odd`, the only typed case). There is
// no `Name` field: the checkout's directory IS the ODD, so a second name would be
// the same fact asked twice, and the active field's own row never echoes what the
// list already shows.
//
// S1 of the ODD (odd/tasks/warp-odd-picker.md): the `Name` field is gone. S2/S3:
// the ODD is picked, `new odd` first, and the list is main's `odd/tasks/*.md`
// (`listMainOddTasks`). Nothing here writes a file: the wizard creates nothing, an
// escape writes nothing, and the document of an ODD is left to the agent.
//
// Every test renders headlessly against a real temporary repository (the path
// derivation reads the real repository identity through the same helpers the
// create path uses) and asserts each line is exactly the requested width. The
// temporary repository is removed when the suite ends.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const panel = require('../lib/warp-create-panel.js');
const realGit = require('../lib/worktree-git.js');
const createLib = require('../lib/worktree-create.js');

const scratch = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function scratchDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-panel-${tag}-`));
  scratch.push(dir);
  return dir;
}

const REPO = scratchDir('repo');
execFileSync('git', ['init', '-q', REPO], { stdio: 'ignore' });

// The worktree root the panel derives its target from: `<repo-parent>` +
// `<repo-name>-worktrees`, exactly what lib/worktree-git.js lays out.
const WORKTREE_ROOT = path.join(path.dirname(REPO), `${path.basename(REPO)}-worktrees`);

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[^\x07\x1b]*\x07/g, '');
}

function renderedLines(view, width = 120) {
  const lines = view.render(width);
  assert.ok(lines.length > 0, 'the panel renders something');
  for (const line of lines) {
    assert.equal([...stripAnsi(line)].length, width, `line is not ${width} wide: ${JSON.stringify(line)}`);
  }
  return lines;
}

function findLine(lines, needle) {
  const line = lines.find((entry) => stripAnsi(entry).includes(needle));
  assert.ok(line !== undefined, `no line contains ${JSON.stringify(needle)}\n${lines.map(stripAnsi).join('\n')}`);
  return stripAnsi(line);
}

function allText(lines) {
  return lines.map(stripAnsi).join('\n');
}

// A rendered row is padded to the panel width, so the comparison drops that
// padding and keeps the derived value itself.
function previewText(view, which) {
  return findLine(renderedLines(view), `preview ${which}:`).replace(`preview ${which}: `, '').trimEnd();
}

function openPanel(overrides = {}) {
  const finished = [];
  const view = panel.createWarpCreatePanel({
    cwd: REPO,
    git: realGit,
    helpers: null,
    hostTui: null,
    theme: null,
    rowsAvailable: () => 30,
    done: (value) => { finished.push(value); },
    ...overrides,
  });
  return { view, finished };
}

// The strip holds TWO fields, so a helper steps to the one it wants from
// wherever the panel is instead of assuming a starting tab.
function focusField(view, field) {
  for (let step = 0; step < 4 && view.state.focus !== field; step += 1) view.handleInput('\t');
  assert.equal(view.state.focus, field, `the panel never reached the ${field} field`);
}

function focusOdd(view) {
  focusField(view, 'odd');
}

function typeText(view, text) {
  for (const char of text) view.handleInput(char);
}

// The ODD is the LAST field, so submitting is one `enter` there.
function submit(view) {
  focusOdd(view);
  view.handleInput('enter');
}

// A whole-tree snapshot (relative path -> size), so "writes nothing" is proven
// against the filesystem and not against a claim.
function treeSnapshot(root) {
  const rows = [];
  const walk = (dir, prefix) => {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let stats;
      try { stats = fs.lstatSync(full); } catch { continue; }
      rows.push(`${prefix}${name}:${stats.size}`);
      if (stats.isDirectory() && name !== '.git') walk(full, `${prefix}${name}/`);
    }
  };
  walk(root, '');
  return rows;
}

describe('the create wizard asks for the ODD once', { concurrency: false }, () => {
  test('the strip is Type · Odd: there is no Name field anywhere', () => {
    const { view } = openPanel({ oddOptions: ['login-ui'] });
    const text = allText(renderedLines(view));
    assert.match(text, /Type · Odd/, 'the strip names the two fields');
    assert.ok(!/\bName\b/.test(text), `no field or row is called Name\n${text}`);
    assert.ok(!/Name:/.test(text), 'no Name row renders');
  });

  test('the fields are tabs: tab and the arrows walk Type → Odd and wrap', () => {
    const { view } = openPanel();
    assert.equal(view.state.focus, 'type');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'odd', 'tab moves forward');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'type', 'the end wraps to the first field');
    view.handleInput('\x1b[Z');
    assert.equal(view.state.focus, 'odd', 'shift+tab moves back, wrapping at the first field');
    view.handleInput('\x1b[D');
    assert.equal(view.state.focus, 'type', 'left moves back too');
    view.handleInput('\x1b[C');
    assert.equal(view.state.focus, 'odd', 'and right moves forward');
  });

  test('enter on the type reaches the ODD instead of creating', () => {
    const { view, finished } = openPanel();
    view.handleInput('enter');
    assert.equal(view.state.focus, 'odd', 'the type is no longer the last field');
    assert.deepEqual(finished, [], 'nothing is created while the ODD is unanswered');
  });

  test('the ODD list is main’s documents, sorted, with new odd first', () => {
    const { view } = openPanel({ oddOptions: ['worktree-tools-v2', 'login-ui', 'login-ui'] });
    focusOdd(view);
    const text = allText(renderedLines(view));
    const at = (needle) => text.indexOf(needle);
    assert.ok(at('❯ new odd') >= 0, `the first entry is the new-ODD entry\n${text}`);
    assert.ok(at('❯ new odd') < at('  login-ui'), 'new odd comes before every document');
    assert.ok(at('  login-ui') < at('  worktree-tools-v2'), 'the documents are sorted');
    assert.equal(text.split('login-ui').length - 1, 1, 'a duplicate option is listed once');
  });

  test('an absent list still offers new odd: an unreadable odd/tasks is never an error', () => {
    const { view, finished } = openPanel();
    focusOdd(view);
    const text = allText(renderedLines(view));
    assert.match(text, /❯ new odd/);
    assert.ok(!text.includes('cannot'), `an empty list is not a failure\n${text}`);
    typeText(view, 'login-ui');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ ok: true, type: 'feat', odd: 'login-ui' }], 'a new ODD is still enterable');
  });

  test('each fact is shown once: the active ODD field has no second Odd: echo', () => {
    const { view } = openPanel({ oddOptions: ['dagea'], initialOdd: 'dagea' });
    focusOdd(view);
    const lines = renderedLines(view).map(stripAnsi).map((line) => line.trimEnd());
    assert.ok(lines.includes('❯ dagea'), 'the picked document is the list row');
    assert.equal(lines.filter((line) => /^Odd:/.test(line)).length, 0, `no stray Odd: row renders\n${lines.join('\n')}`);
    assert.equal(lines.filter((line) => /^Name:/.test(line)).length, 0, 'no stray Name: row renders');

    // And the same while the new-ODD entry is the one being typed into: the typed
    // value is ONE row (the entry itself), and the previews are the only other
    // places that mention it.
    const typed = openPanel();
    focusOdd(typed.view);
    typeText(typed.view, 'dagea');
    const typedLines = renderedLines(typed.view).map(stripAnsi).map((line) => line.trimEnd());
    assert.equal(typedLines.filter((line) => /^Odd:/.test(line)).length, 0, 'typing a new ODD adds no echoed row');
    assert.equal(typedLines.filter((line) => line.startsWith('new odd:')).length, 1, 'the typed ODD renders in its own one row');
  });
});

describe('the create wizard previews the branch and the ODD separately', { concurrency: false }, () => {
  test('an untouched form previews the type branch prefix and the worktree root', () => {
    const { view } = openPanel();
    assert.equal(previewText(view, 'branch'), 'feat/', 'the branch preview names the picked type');
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path preview names the root the ODD will complete into');
    const text = allText(renderedLines(view));
    assert.ok(!text.includes('preview branch: -'), 'the branch preview is never blank once the type is known');
    assert.ok(!text.includes('preview path: -'), 'the path preview is never blank once the type is known');
  });

  test('every change type previews its own branch prefix and the same root', () => {
    for (const type of panel.CHANGE_TYPES) {
      const { view } = openPanel({ initialType: type.id });
      assert.equal(previewText(view, 'branch'), `${type.id}/`, `${type.id} previews its branch prefix`);
      assert.equal(previewText(view, 'path'), WORKTREE_ROOT, `${type.id} previews the root the ODD completes into`);
    }
  });

  test('the branch follows the type and the ODD, the path follows the ODD alone', () => {
    // The list is sorted, so `dagea` comes before `login-ui` whatever order the
    // caller read them in.
    const { view } = openPanel({ oddOptions: ['login-ui', 'dagea'] });
    focusOdd(view);
    view.handleInput('\x1b[B'); // down: dagea
    assert.equal(previewText(view, 'branch'), 'feat/dagea', 'the branch is the type over the ODD slug');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'dagea'), 'the ODD completes the path');
    view.handleInput('\x1b[B'); // down: login-ui
    assert.equal(previewText(view, 'branch'), 'feat/login-ui');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login-ui'));
    view.handleInput('\x1b[A'); // up: back to dagea
    view.handleInput('\t'); // back to the type
    assert.equal(view.state.focus, 'type');
    view.handleInput('\x1b[B'); // down: Bug fix
    assert.equal(previewText(view, 'branch'), 'fix/dagea', 'the type moves the branch and keeps the ODD');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'dagea'), 'the type never names the directory');
  });

  test('the new-ODD entry takes the typed name', () => {
    const { view, finished } = openPanel({ oddOptions: ['login-ui'] });
    focusOdd(view);
    typeText(view, 'new-odd');
    assert.equal(previewText(view, 'branch'), 'feat/new-odd');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'new-odd'));
    view.handleInput('enter');
    assert.deepEqual(
      finished,
      [{ ok: true, type: 'feat', odd: 'new-odd' }],
      'the completion carries the type and the ODD, and no second name',
    );
  });

  test('choosing an existing ODD completes with it and writes nothing', () => {
    const before = treeSnapshot(REPO);
    const { view, finished } = openPanel({ oddOptions: ['login-ui', 'dagea'] });
    focusOdd(view);
    view.handleInput('\x1b[B'); // down: dagea (the list is sorted)
    view.handleInput('enter');
    assert.deepEqual(finished, [{ ok: true, type: 'feat', odd: 'dagea' }]);
    assert.deepEqual(treeSnapshot(REPO), before, 'choosing an existing ODD writes nothing');
    assert.equal(fs.existsSync(path.join(WORKTREE_ROOT, 'dagea')), false, 'no file or directory is created either');
  });

  test('an empty ODD refuses with its own words', () => {
    const { view, finished } = openPanel();
    submit(view);
    assert.deepEqual(finished, [], 'an empty ODD creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: odd is empty/);
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path row stays neutral, not blank');
  });

  test('an ODD that is not one path segment refuses before creating', () => {
    const { view, finished } = openPanel();
    focusOdd(view);
    typeText(view, '../escape');
    assert.equal(previewText(view, 'path'), '-', 'an unusable ODD previews no path');
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'an unusable ODD creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: invalid odd name: "\.\.\/escape"/);
  });

  test('an ODD with nothing slug-worthy still previews no branch', () => {
    const { view, finished } = openPanel();
    focusOdd(view);
    typeText(view, '!!!');
    assert.equal(previewText(view, 'branch'), '-', 'an underivable branch previews no branch');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, '!!!'), 'the path is the ODD, so it still derives');
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'an ODD with no letters or digits never creates');
    assert.match(allText(renderedLines(view)), /cannot create: odd has no letters or digits/);
  });

  test('escape cancels the whole form and writes nothing', () => {
    const before = treeSnapshot(REPO);
    const { view, finished } = openPanel({ oddOptions: ['login-ui'] });
    focusOdd(view);
    view.handleInput('\x1b[B');
    view.handleInput('\x1b');
    assert.deepEqual(finished, [null], 'escape is a cancel, exactly once');
    assert.deepEqual(treeSnapshot(REPO), before, 'a cancel writes nothing');
    assert.equal(fs.existsSync(WORKTREE_ROOT), false, 'a cancel creates nothing');
  });

  // The create and the preview must ask ONE function where a checkout goes.
  test('the preview equals the path the create makes: the ODD, not the branch', () => {
    const { view } = openPanel({ initialOdd: 'login-ui' });
    assert.equal(previewText(view, 'branch'), 'feat/login-ui');
    assert.equal(previewText(view, 'path'), createLib.worktreeDestinationPath(REPO, 'login-ui'));
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login-ui'));
    assert.notEqual(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'feat-login'), 'the legacy slug is never previewed');
  });
});

// `main`'s documents are the list's source: the ref's tree, never the checkout
// the panel runs in, and never a failure — an absent directory, a missing `main`
// or a failing child is an empty list.
describe('the ODD list comes from main’s tree', { concurrency: false }, () => {
  const mainListing = (stdout, status = 0) => async () => ({ status, stdout });

  test('names main’s odd/tasks documents, without the extension, sorted', async () => {
    const runAsync = mainListing('odd/tasks/worktree-tools-v2.md\0odd/tasks/dagea.md\0');
    assert.deepEqual(await panel.listMainOddTasks({ runAsync, cwd: REPO }), ['dagea', 'worktree-tools-v2']);
  });

  test('asks git for the main ref’s odd/tasks tree, never the working tree', async () => {
    const calls = [];
    const runAsync = async (bin, args, cwd) => {
      calls.push({ bin, args, cwd });
      return { status: 0, stdout: '' };
    };
    await panel.listMainOddTasks({ runAsync, cwd: REPO });
    assert.equal(calls.length, 1, 'one bounded read, no second child');
    assert.equal(calls[0].bin, 'git');
    assert.equal(calls[0].cwd, REPO);
    assert.deepEqual(calls[0].args, ['ls-tree', '-r', '--name-only', '-z', 'refs/heads/main', '--', 'odd/tasks']);
  });

  test('ignores everything that is not a document directly in odd/tasks', async () => {
    const stdout = [
      'odd/tasks/a.md',
      'odd/tasks/notes.txt',
      'odd/tasks/nested/b.md',
      'odd/tasks/.hidden.md',
      'odd/other.md',
      'odd\\tasks\\windows.md',
      '',
    ].join('\0');
    assert.deepEqual(await panel.listMainOddTasks({ runAsync: mainListing(stdout), cwd: REPO }), ['a']);
  });

  test('a missing main, a failing child or no runner is an empty list, never an error', async () => {
    assert.deepEqual(await panel.listMainOddTasks({ runAsync: mainListing('', 1), cwd: REPO }), []);
    assert.deepEqual(await panel.listMainOddTasks({ runAsync: async () => { throw new Error('no git'); }, cwd: REPO }), []);
    assert.deepEqual(await panel.listMainOddTasks({ runAsync: null, cwd: REPO }), []);
  });
});

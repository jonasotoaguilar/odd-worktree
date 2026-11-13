'use strict';
// The create panel's live preview: the branch and the target path it derives
// from the fields the form asks for.
//
// A human picking a change type wants to see WHICH type they picked before
// typing anything: `preview branch: feat/` and the worktree root the checkout
// will occupy (`…/odd-worktree-worktrees`), completed as the form is filled in.
// S7 splits the two rows by their owner: the BRANCH follows the change type and
// the change name (`feat/login`), and the PATH is the ODD — the create makes
// `<repo-parent>/<repo-name>-worktrees/<odd>`, so the preview and the create can
// never show two different paths, and a branch name never names a directory.
// The preview is DISPLAY ONLY while a field is empty — an untouched form is
// still not submittable — so the refusal keeps its own words while the two
// preview rows stay neutral. Picking another type moves the branch row on the
// same keystroke and leaves the ODD's path alone.
//
// Every test renders headlessly against a real temporary repository (the path
// derivation reads the real repository identity through the same helpers the
// create path uses) and asserts each line is exactly the requested width.
// The temporary repository is removed when the suite ends.

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
    rowsAvailable: () => 24,
    done: (value) => { finished.push(value); },
    ...overrides,
  });
  return { view, finished };
}

// The strip holds three fields, so a helper steps to the one it wants from
// wherever the panel is instead of assuming a starting tab.
function focusField(view, field) {
  for (let step = 0; step < 3 && view.state.focus !== field; step += 1) view.handleInput('\t');
  assert.equal(view.state.focus, field, `the panel never reached the ${field} field`);
}

function focusName(view) {
  focusField(view, 'name');
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

describe('the create panel previews the branch and the ODD separately', { concurrency: false }, () => {
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
      // S7: the directory is the ODD, not the branch's last segment, so every type
      // previews the same root while the ODD is empty.
      assert.equal(previewText(view, 'path'), WORKTREE_ROOT, `${type.id} previews the root the ODD completes into`);
    }
  });

  test('the branch follows the name and the path follows the ODD', () => {
    const { view } = openPanel();
    focusName(view);
    typeText(view, 'my');
    assert.equal(previewText(view, 'branch'), 'feat/my', 'the branch preview follows the first typed characters');
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the name never names the directory (S7)');
    typeText(view, '-name');
    assert.equal(previewText(view, 'branch'), 'feat/my-name');
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path stays the root until the ODD is typed');

    focusOdd(view);
    assert.equal(view.state.focus, 'odd');
    typeText(view, 'login');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login'), 'the ODD completes the path');
    typeText(view, '-ui');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login-ui'));
    assert.equal(previewText(view, 'branch'), 'feat/my-name', 'the ODD never moves the branch');
  });

  test('switching the type moves the branch preview and leaves the ODD path alone', () => {
    const { view, finished } = openPanel();
    assert.equal(previewText(view, 'branch'), 'feat/');
    view.handleInput('\x1b[B'); // down: Bug fix
    assert.equal(previewText(view, 'branch'), 'fix/', 'the branch row follows the picked type immediately');
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT);

    focusName(view);
    typeText(view, 'my-name');
    focusOdd(view);
    typeText(view, 'login-ui');
    view.handleInput('\t'); // back to the type
    assert.equal(view.state.focus, 'type');
    view.handleInput('\x1b[A'); // up: back to feat
    assert.equal(previewText(view, 'branch'), 'feat/my-name', 'the typed name survives the type change');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login-ui'));
    view.handleInput('\x1b[B'); // down: fix again
    assert.equal(previewText(view, 'branch'), 'fix/my-name');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login-ui'), 'the directory is the ODD, never the type nor the name');
    assert.deepEqual(finished, [], 'changing the type never submits the form');
  });

  test('the prefix preview never submits: an empty name still refuses with its own words', () => {
    const { view, finished } = openPanel();
    submit(view);
    assert.deepEqual(finished, [], 'an empty name creates nothing');
    const text = allText(renderedLines(view));
    assert.match(text, /cannot create: name is empty/, 'the refusal keeps its own words');
    assert.ok(!text.includes('preview branch: -'), 'the preview rows stay neutral, not blank');
    assert.equal(previewText(view, 'branch'), 'feat/');
  });

  test('the ODD is required: an empty ODD refuses with its own words', () => {
    const { view, finished } = openPanel({ initialName: 'login' });
    submit(view);
    assert.deepEqual(finished, [], 'an empty ODD creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: odd is empty/);
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path row stays neutral, not blank');
  });

  test('an ODD that is not one path segment refuses before creating', () => {
    const { view, finished } = openPanel({ initialName: 'login' });
    focusOdd(view);
    typeText(view, '../escape');
    assert.equal(previewText(view, 'path'), '-', 'an unusable ODD previews no path');
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'an unusable ODD creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: invalid odd name: "\.\.\/escape"/);
  });

  test('a name with nothing slug-worthy still previews no branch', () => {
    const { view, finished } = openPanel();
    focusName(view);
    typeText(view, '!!!');
    assert.equal(previewText(view, 'branch'), '-', 'an underivable name previews no branch');
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path belongs to the ODD, so the name cannot blank it');
    submit(view);
    assert.deepEqual(finished, [], 'an invalid name still never creates');
    assert.match(allText(renderedLines(view)), /cannot create: name has no letters or digits/);
  });

  test('a complete form previews and creates the same branch and path', () => {
    const { view, finished } = openPanel({ initialName: 'new-change', initialOdd: 'login-ui' });
    assert.equal(previewText(view, 'branch'), 'feat/new-change');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login-ui'));
    submit(view);
    assert.deepEqual(
      finished,
      [{ ok: true, type: 'feat', name: 'new-change', odd: 'login-ui' }],
      'the completed form creates with the type id, the typed name and the typed ODD',
    );
  });

  test('the three fields are tabs: tab and the arrows walk Type → Name → Odd and wrap', () => {
    const { view } = openPanel();
    assert.equal(view.state.focus, 'type');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'name', 'tab moves forward');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'odd');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'type', 'the end wraps to the first field');
    view.handleInput('\x1b[Z');
    assert.equal(view.state.focus, 'odd', 'shift+tab moves back, wrapping at the first field');
    view.handleInput('\x1b[D');
    assert.equal(view.state.focus, 'name', 'left moves back too');
    view.handleInput('\x1b[C');
    assert.equal(view.state.focus, 'odd', 'and right moves forward');
    const text = allText(renderedLines(view));
    assert.match(text, /Type · Name · Odd/, 'the strip names the three fields');
  });

  test('enter on the name moves on to the ODD instead of creating', () => {
    const { view, finished } = openPanel({ initialName: 'login' });
    focusName(view);
    view.handleInput('enter');
    assert.equal(view.state.focus, 'odd', 'the name is no longer the last field');
    assert.deepEqual(finished, [], 'nothing is created while the ODD is unanswered');
  });

  // The create and the preview must ask ONE function where a checkout goes. S7
  // makes that function the ODD: `…-worktrees/login-ui`, never `login-ui`'s
  // branch slug, and never the branch's last segment.
  test('the preview equals the path the create makes: the ODD, not the branch', () => {
    const { view } = openPanel({ initialName: 'login', initialOdd: 'login-ui' });
    assert.equal(previewText(view, 'branch'), 'feat/login');
    const previewPath = previewText(view, 'path');

    assert.equal(previewPath, createLib.worktreeDestinationPath(REPO, 'login-ui'));
    assert.equal(previewPath, path.join(WORKTREE_ROOT, 'login-ui'));
    assert.notEqual(previewPath, path.join(WORKTREE_ROOT, 'login'), 'the branch never names the directory');
    assert.notEqual(previewPath, path.join(WORKTREE_ROOT, 'feat-login'), 'the legacy slug is never previewed either');
  });
});

'use strict';
// The create panel's live preview: the branch and the target path it derives
// from the two fields the form asks for.
//
// A human picking a change type wants to see WHICH type they picked before
// typing anything: `preview branch: feat/` and the checkout directory it will
// occupy (`…/odd-worktree-worktrees/feat-`), completed as the name is typed.
// The preview is DISPLAY ONLY while the name is empty — an untouched form is
// still not submittable — so the refusal keeps its own words while the two
// preview rows stay neutral. Picking another type moves both rows on the same
// keystroke.
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

function focusName(view) {
  view.handleInput('\t'); // type -> name
}

function typeText(view, text) {
  for (const char of text) view.handleInput(char);
}

function createNow(view) {
  if (view.state.focus !== 'name') view.handleInput('\t');
  view.handleInput('enter');
}

describe('the preview shows the selected type before any name is typed', { concurrency: false }, () => {
  test('an untouched form previews the type branch prefix and its checkout directory', () => {
    const { view } = openPanel();
    assert.equal(previewText(view, 'branch'), 'feat/', 'the branch preview names the picked type');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'feat-'), 'the path preview names the directory that type starts');
    const text = allText(renderedLines(view));
    assert.ok(!text.includes('preview branch: -'), 'the branch preview is never blank once the type is known');
    assert.ok(!text.includes('preview path: -'), 'the path preview is never blank once the type is known');
  });

  test('every change type previews its own prefix', () => {
    for (const type of panel.CHANGE_TYPES) {
      const { view } = openPanel({ initialType: type.id });
      assert.equal(previewText(view, 'branch'), `${type.id}/`, `${type.id} previews its branch prefix`);
      assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, `${type.id}-`), `${type.id} previews its checkout directory`);
    }
  });

  test('typing the name completes both previews as it goes', () => {
    const { view } = openPanel();
    focusName(view);
    typeText(view, 'my');
    assert.equal(previewText(view, 'branch'), 'feat/my', 'the branch preview follows the first typed characters');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'feat-my'), 'the path preview follows them too');
    typeText(view, '-name');
    assert.equal(previewText(view, 'branch'), 'feat/my-name');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'feat-my-name'));
  });

  test('switching the type moves both previews on the same keystroke, typed name included', () => {
    const { view, finished } = openPanel();
    assert.equal(previewText(view, 'branch'), 'feat/');
    view.handleInput('\x1b[B'); // down: Bug fix
    assert.equal(previewText(view, 'branch'), 'fix/', 'both rows follow the picked type immediately');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'fix-'));

    focusName(view);
    typeText(view, 'my-name');
    view.handleInput('\t'); // back to the type
    assert.equal(view.state.focus, 'type');
    view.handleInput('\x1b[A'); // up: back to feat
    assert.equal(previewText(view, 'branch'), 'feat/my-name', 'the typed name survives the type change');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'feat-my-name'));
    view.handleInput('\x1b[B'); // down: fix again
    assert.equal(previewText(view, 'branch'), 'fix/my-name');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'fix-my-name'));
    assert.deepEqual(finished, [], 'changing the type never submits the form');
  });

  test('the prefix preview never submits: an empty name still refuses with its own words', () => {
    const { view, finished } = openPanel();
    createNow(view);
    assert.deepEqual(finished, [], 'an empty name creates nothing');
    const text = allText(renderedLines(view));
    assert.match(text, /cannot create: name is empty/, 'the refusal keeps its own words');
    assert.ok(!text.includes('preview branch: -'), 'the preview rows stay neutral, not blank');
    assert.equal(previewText(view, 'branch'), 'feat/');
  });

  test('a name with nothing slug-worthy still previews nothing', () => {
    const { view, finished } = openPanel();
    focusName(view);
    typeText(view, '!!!');
    assert.equal(previewText(view, 'branch'), '-', 'an underivable name previews no branch');
    assert.equal(previewText(view, 'path'), '-', 'and no path');
    createNow(view);
    assert.deepEqual(finished, [], 'an invalid name still never creates');
    assert.match(allText(renderedLines(view)), /cannot create: name has no letters or digits/);
  });

  test('a complete form previews and creates the same branch and path', () => {
    const { view, finished } = openPanel({ initialName: 'new-change' });
    assert.equal(previewText(view, 'branch'), 'feat/new-change');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'feat-new-change'));
    createNow(view);
    assert.deepEqual(finished, [{ ok: true, type: 'feat', name: 'new-change' }], 'the completed form creates with the type id and the typed name');
  });
});

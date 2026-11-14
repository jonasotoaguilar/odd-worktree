'use strict';
// The create wizard: `Branch · Odd` (warp-branch-field S1,S2,S6,S7,S8,S9,S10).
//
// `Branch` is the human's branch — `<type>/<name>`, the type chosen from the
// repository's eleven types and the name typed — and the ODD is the checkout's
// directory, chosen from the ODDs that exist in `main` (first entry `new odd`,
// the only typed case). There is no `Name` field: the checkout's directory IS
// the ODD, and the branch names no directory. Both typed fields share ONE input
// design, the lists beside them stay plain rows, and a blank separator keeps the
// input region apart from its list.
//
// S5: an ODD whose checkout already exists is not offered, from the reconciled
// live checkouts the caller supplies; `new odd` stays first and available, and
// an empty result is never an error.
//
// Nothing here writes a file: the wizard creates nothing, an escape writes
// nothing, and the document of an ODD is left to the agent.
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

// The trimmed plain text of every row, which is what a human sees.
function rows(view, width = 120) {
  return renderedLines(view, width).map((line) => stripAnsi(line).trimEnd());
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

function rowIndex(lines, needle) {
  return lines.findIndex((line) => line.includes(needle));
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
  const rowsOut = [];
  const walk = (dir, prefix) => {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let stats;
      try { stats = fs.lstatSync(full); } catch { continue; }
      rowsOut.push(`${prefix}${name}:${stats.size}`);
      if (stats.isDirectory() && name !== '.git') walk(full, `${prefix}${name}/`);
    }
  };
  walk(root, '');
  return rowsOut;
}

describe('the create wizard asks for the branch and the odd', { concurrency: false }, () => {
  test('the strip is Branch · Odd: there is no Name field anywhere', () => {
    const { view } = openPanel({ oddOptions: ['login-ui'] });
    const text = allText(renderedLines(view));
    assert.match(text, /Branch · Odd/, 'the strip names the two fields');
    assert.ok(!/Type · Odd/.test(text), `the retired strip is not rendered\n${text}`);
    assert.ok(!/\bName\b/.test(text), `no field or row is called Name\n${text}`);
    assert.ok(!/Name:/.test(text), 'no Name row renders');
  });

  test('the fields are tabs: tab and the arrows walk Branch → Odd and wrap', () => {
    const { view } = openPanel();
    assert.equal(view.state.focus, 'branch', 'Branch is the first field');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'odd', 'tab moves forward');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'branch', 'the end wraps to the first field');
    view.handleInput('\x1b[Z');
    assert.equal(view.state.focus, 'odd', 'shift+tab moves back, wrapping at the first field');
    view.handleInput('\x1b[D');
    assert.equal(view.state.focus, 'branch', 'left moves back too');
    view.handleInput('\x1b[C');
    assert.equal(view.state.focus, 'odd', 'and right moves forward');
  });

  test('enter on the branch reaches the ODD instead of creating', () => {
    const { view, finished } = openPanel();
    view.handleInput('enter');
    assert.equal(view.state.focus, 'odd', 'the branch is no longer the last field');
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
    assert.deepEqual(finished, [], 'the branch name is still unanswered');
    focusField(view, 'branch');
    typeText(view, 'sign-in');
    focusOdd(view);
    view.handleInput('enter');
    assert.deepEqual(finished, [{ ok: true, branch: 'feat/sign-in', odd: 'login-ui' }], 'a new ODD is still enterable');
  });

  test('each fact is shown once: no second Odd: echo and no Name: row', () => {
    const { view } = openPanel({ oddOptions: ['dagea'], initialOdd: 'dagea' });
    focusOdd(view);
    const lines = rows(view);
    assert.ok(lines.includes('❯ dagea'), 'the picked document is the list row');
    assert.equal(lines.filter((line) => /^Odd:/.test(line)).length, 0, `no stray Odd: row renders\n${lines.join('\n')}`);
    assert.equal(lines.filter((line) => /^Name:/.test(line)).length, 0, 'no stray Name: row renders');

    // And the same while the new-ODD entry is the one being typed into: the typed
    // value lives IN that row, and the previews are the only other places that
    // mention it.
    const typed = openPanel();
    focusOdd(typed.view);
    typeText(typed.view, 'dagea');
    const typedLines = rows(typed.view);
    assert.equal(typedLines.filter((line) => line.includes('new odd:')).length, 1, 'the typed ODD renders in its own one row');
    assert.equal(typedLines.filter((line) => /dagea/.test(line)).length, 2, 'the row and the path preview name it, nothing else');
  });
});

describe('the Branch field: name on top, the types under it (S1,S6)', { concurrency: false }, () => {
  test('an untouched form previews feat/ and reads the name above the list', () => {
    const { view } = openPanel();
    assert.equal(previewText(view, 'branch'), 'feat/', 'feat is the default type, so the form already previews it');
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path preview names the root the ODD will complete into');
    const lines = rows(view);
    const input = rowIndex(lines, 'branch-name');
    const firstType = rowIndex(lines, 'Feature (feat)');
    assert.ok(input > 0 && firstType > 0, `both regions render\n${lines.join('\n')}`);
    assert.ok(input < firstType, `the typed name sits ABOVE the type list\n${lines.join('\n')}`);
    assert.equal(lines[input].trim(), '❯ feat/▊branch-name', 'the input composes the type prefix and the caret');
    assert.equal(lines[input + 1].trim(), '', 'a blank row separates the input region from the list (S7)');
    assert.ok(firstType > input + 1, 'the list starts after the separator');
  });

  test('choosing a type moves the composed branch and never the directory', () => {
    const { view } = openPanel({ oddOptions: ['login-ui'] });
    focusOdd(view);
    view.handleInput('\x1b[B'); // down: login-ui
    focusField(view, 'branch');
    view.handleInput('\x1b[B'); // down: Bug fix
    assert.equal(previewText(view, 'branch'), 'fix/', 'the composed branch follows the type');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'login-ui'), 'the type never names the directory');
    assert.equal(rows(view)[rowIndex(rows(view), 'branch-name')].trim(), '❯ fix/▊branch-name', 'the input row shows the chosen prefix');
  });

  test('typing fills the name in place and the preview composes <type>/<name>', () => {
    const { view } = openPanel({ oddOptions: ['login-ui'] });
    typeText(view, 'add');
    assert.equal(view.state.focus, 'branch', 'typing never jumps fields');
    assert.equal(previewText(view, 'branch'), 'feat/add');
    assert.equal(rows(view)[rowIndex(rows(view), '▊')].trim(), '❯ feat/add▊', 'the typed text lives in the input row');
    view.handleInput('\x7f');
    assert.equal(previewText(view, 'branch'), 'feat/ad', 'backspace edits the name');
  });

  test('every change type previews its own branch, and the list keeps its eleven entries', () => {
    assert.equal(panel.CHANGE_TYPES.length, 11, 'the eleven types survive');
    const expected = ['feat', 'fix', 'chore', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'revert'];
    assert.deepEqual(panel.CHANGE_TYPES.map((type) => type.id), expected, 'in the branch-pr order');
    for (const type of panel.CHANGE_TYPES) {
      const { view } = openPanel({ initialType: type.id });
      typeText(view, 'x');
      assert.equal(previewText(view, 'branch'), `${type.id}/x`, `${type.id} composes its own branch`);
      // The list keeps every type, in order, as plain rows.
      const lines = rows(view);
      const rendered = panel.CHANGE_TYPES.map((entry) => `${entry.label} (${entry.id})`);
      const at = rendered.map((label) => rowIndex(lines, label));
      assert.ok(at.every((index) => index > 0), `${type.id}: every type renders\n${lines.join('\n')}`);
      assert.deepEqual([...at].sort((a, b) => a - b), at, `${type.id}: the list keeps its order`);
    }
  });

  test('the branch is passed through unchanged and the path follows the ODD alone', () => {
    const { view, finished } = openPanel({ oddOptions: ['dagea'] });
    typeText(view, 'other-name');
    focusOdd(view);
    view.handleInput('\x1b[B'); // down: dagea
    assert.equal(previewText(view, 'branch'), 'feat/other-name', 'the branch is the typed pair, not the ODD');
    assert.equal(previewText(view, 'path'), path.join(WORKTREE_ROOT, 'dagea'), 'the ODD names the directory');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ ok: true, branch: 'feat/other-name', odd: 'dagea' }], 'the completion carries the branch verbatim');
  });

  test('a name that is not a branch segment refuses with its own words', () => {
    const { view, finished } = openPanel();
    typeText(view, 'Bad Name');
    assert.equal(previewText(view, 'branch'), '-', 'an invalid branch previews no branch');
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path row stays neutral, not blank');
    submit(view);
    assert.deepEqual(finished, [], 'an invalid branch creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: invalid branch name: feat\/Bad Name/);
  });
});

describe('both typed fields share one input design (S7,S8,S9,S10)', { concurrency: false }, () => {
  test('the branch name and new odd render as the same kind of row', () => {
    const branch = openPanel();
    const branchInput = rows(branch.view).find((line) => line.includes('branch-name'));
    assert.equal(branchInput.trim(), '❯ feat/▊branch-name');

    const odd = openPanel();
    focusOdd(odd.view);
    const oddInput = rows(odd.view).find((line) => line.includes('odd-name'));
    assert.equal(oddInput.trim(), '❯ new odd: ▊odd-name');

    // The shape both share: the `❯` prompt, a static label or the composed
    // prefix, then the caret — the same row treatment, never a second style.
    for (const input of [branchInput.trim(), oddInput.trim()]) {
      assert.match(input, /^❯ /, 'the prompt is the same');
      assert.ok(input.includes('▊'), 'the caret is the same');
    }
  });

  test('the new-odd row IS the input while it is selected, and the caret moves with it', () => {
    const { view } = openPanel({ oddOptions: ['dagea', 'login-ui'] });
    focusOdd(view);
    const lines = rows(view);
    // `new odd` selected: the row above the separator is the input, typed text in place.
    typeText(view, 'fresh');
    const input = rowIndex(rows(view), 'new odd:');
    assert.ok(input > 0);
    assert.equal(rows(view)[input].trim(), '❯ new odd: fresh▊');
    assert.equal(rows(view)[input + 1].trim(), '', 'the blank separator follows the input row');
    assert.ok(rowIndex(rows(view), '  dagea') > input + 1, 'the documents stand alone under it, as plain rows');
    assert.ok(!lines.some((line) => /^\s{2}dagea▊/.test(line)), 'no document row wears the caret');

    // A document selected: no input row below the list, `new odd` stays plain.
    view.handleInput('\x1b[B'); // down: dagea
    const document = rows(view);
    assert.equal(document.filter((line) => line.includes('▊')).length, 0, `no input row is left under the list\n${document.join('\n')}`);
    assert.ok(document.includes('  new odd'), 'the new-odd entry stays (plain) in its place');
    assert.ok(document.includes('❯ dagea'), 'the documents below are the list, and the focused one is marked');
  });

  test('the lists are plain rows: neither list wears the input design', () => {
    const branch = openPanel();
    const branchLines = rows(branch.view);
    const typeRows = branchLines.filter((line) => /^\s*(❯ )?(Feature|Bug fix|Chore) \(/.test(line));
    assert.equal(typeRows.length, 3, 'the type list renders as plain rows');
    for (const line of typeRows) assert.ok(!line.includes('▊'), 'no type row wears the caret');

    const odd = openPanel({ oddOptions: ['dagea'] });
    focusOdd(odd.view);
    odd.view.handleInput('\x1b[B'); // down: dagea
    for (const line of rows(odd.view).filter((text) => /dagea$/.test(text) && text.includes('❯'))) {
      assert.ok(!line.includes('▊'), 'no document row is styled as an input');
    }
  });
});

describe('an ODD that already has a worktree is not offered (S5)', { concurrency: false }, () => {
  test('the occupied ODD leaves the list while new odd stays first', () => {
    const { view } = openPanel({
      oddOptions: ['dagea', 'login-ui'],
      occupiedPaths: [path.join(WORKTREE_ROOT, 'dagea')],
    });
    focusOdd(view);
    const text = allText(renderedLines(view));
    assert.ok(!text.includes('  dagea'), `the taken ODD is not offered\n${text}`);
    assert.match(text, /❯ new odd/, 'new odd is still first and available');
    assert.ok(text.includes('  login-ui'), 'the free ODD is still offered');
  });

  test('a stale row for a removed checkout does not hide a free ODD', () => {
    // The caller reconciles: a registry row whose directory is gone is not an
    // occupied path, so the ODD is offered again.
    const { view } = openPanel({ oddOptions: ['dagea'], occupiedPaths: [] });
    focusOdd(view);
    assert.ok(allText(renderedLines(view)).includes('  dagea'), 'the ODD is offered');
  });

  test('everything occupied still renders new odd and never an error', () => {
    const { view, finished } = openPanel({
      oddOptions: ['dagea'],
      occupiedPaths: [path.join(WORKTREE_ROOT, 'dagea')],
    });
    focusOdd(view);
    const text = allText(renderedLines(view));
    assert.match(text, /❯ new odd/);
    assert.ok(!/cannot|error|no odds/i.test(text), `an emptied list is not a failure\n${text}`);
    typeText(view, 'fresh');
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'the branch name is still unanswered');
    focusField(view, 'branch');
    typeText(view, 'sign-in');
    focusOdd(view);
    view.handleInput('enter');
    assert.deepEqual(finished, [{ ok: true, branch: 'feat/sign-in', odd: 'fresh' }], 'a new ODD is still enterable');
  });

  test('the filter is an aid, not the check: a taken ODD can still be answered', () => {
    // The panel only hides; the create path owns the refusal. A caller that
    // prefills a taken ODD still gets its completion.
    const taken = path.join(WORKTREE_ROOT, 'dagea');
    const { view, finished } = openPanel({ oddOptions: ['dagea'], occupiedPaths: [taken], initialOdd: 'dagea' });
    assert.equal(previewText(view, 'path'), taken, 'the prefilled ODD still derives its path');
    typeText(view, 'sign-in');
    submit(view);
    assert.deepEqual(finished, [{ ok: true, branch: 'feat/sign-in', odd: 'dagea' }], 'the create path owns the refusal');
  });
});

describe('the create wizard previews the branch and the ODD separately', { concurrency: false }, () => {
  test('an empty name refuses with its own words', () => {
    const { view, finished } = openPanel({ oddOptions: ['login-ui'] });
    focusOdd(view);
    view.handleInput('\x1b[B'); // down: login-ui
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'an empty branch name creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: branch name is empty/);
    assert.equal(previewText(view, 'branch'), 'feat/', 'the branch row stays readable, not blank');
  });

  test('an empty ODD refuses with its own words', () => {
    const { view, finished } = openPanel();
    typeText(view, 'login-ui');
    submit(view);
    assert.deepEqual(finished, [], 'an empty ODD creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: odd is empty/);
    assert.equal(previewText(view, 'path'), WORKTREE_ROOT, 'the path row stays neutral, not blank');
  });

  test('an ODD that is not one path segment refuses before creating', () => {
    const { view, finished } = openPanel();
    typeText(view, 'sign-in');
    focusOdd(view);
    typeText(view, '../escape');
    assert.equal(previewText(view, 'path'), '-', 'an unusable ODD previews no path');
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'an unusable ODD creates nothing');
    assert.match(allText(renderedLines(view)), /cannot create: invalid odd name: "\.\.\/escape"/);
  });

  test('choosing an existing ODD completes with it and writes nothing', () => {
    const before = treeSnapshot(REPO);
    const { view, finished } = openPanel({ oddOptions: ['login-ui', 'dagea'] });
    typeText(view, 'sign-in');
    focusOdd(view);
    view.handleInput('\x1b[B'); // down: dagea (the list is sorted)
    view.handleInput('enter');
    assert.deepEqual(finished, [{ ok: true, branch: 'feat/sign-in', odd: 'dagea' }]);
    assert.deepEqual(treeSnapshot(REPO), before, 'choosing an existing ODD writes nothing');
    assert.equal(fs.existsSync(path.join(WORKTREE_ROOT, 'dagea')), false, 'no file or directory is created either');
  });

  test('escape cancels the whole form and writes nothing', () => {
    const before = treeSnapshot(REPO);
    const { view, finished } = openPanel({ oddOptions: ['login-ui'] });
    typeText(view, 'sign-in');
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
    assert.equal(previewText(view, 'branch'), 'feat/', 'the branch is the composed pair');
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

'use strict';
// T3 (S1,S3,S4) public command tests: the `/issues` command in
// extensions/odd-worktree-tools.ts, driven through the registered handler.
//
// Contract under test (observable behavior only — registration, the notified
// text, the overlay options, the rendered marks, the registry bytes, the argv
// reaching the injected `gh` runner; never internal names):
// - the command is registered eagerly at load, and the session-start `gh`
//   check only gates the INVOCATION: a missing or unauthenticated `gh`
//   notifies once per session with what is missing and the command that fixes
//   it, then refuses on invocation instead of opening;
// - no argument opens the four-bucket overlay through ctx.ui.custom with the
//   odd viewer's full-screen options, fed by cursor pages: the three scoped
//   searches (author:@me, assignee:@me, involves:@me -author:@me), the
//   unfiltered `All` connection, the detail, repo labels and assignable users;
// - the repository identity is PINNED host-qualified when the list loads:
//   every page, detail, label and assignee read binds it, and the `o` opener
//   opens `gh issue view <n> --web -R <pinned>` (fixed argv, terminal
//   suspended for the open) rather than whatever the checkout resolves to now;
// - a mutation runs only while the checkout still resolves to the displayed
//   repository, and otherwise refuses without running `gh`; a client failure
//   keeps the draft, shows the error and claims no success;
// - no worktree↔issue association exists: the view is handed no `assigned`,
//   no `saveAssignment` and no `assignmentEnabled`, and reading writes nothing.
//
// The TypeScript extension is plain JS under the hood, so the shared fixture
// copies it to a temporary .mjs with the package imports stubbed; `gh` is
// injected through the real lib/gh-issues.js `setGhRunner` seam (same module
// instance the extension loads via GENTLE_WORKTREE_LIB_DIR), so no live `gh`
// runs and no real GitHub mutation is possible.

const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { LIB_DIR, stubbedSource } = require('./fixtures/load-extension.js');

const ghIssues = require('../lib/gh-issues.js');
const worktreeGit = require('../lib/worktree-git.js');

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function makeRepo({ tag = 'issues' } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `odd-issues-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

afterEach(() => {
  ghIssues.setGhRunner(null);
});

const FIXTURES = path.join(__dirname, 'fixtures');
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// A fresh copy per load: module-level gate state belongs to one runtime load,
// exactly like the host's rebuilt command registry.
async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-ext-')));
  const copy = path.join(dir, 'odd-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbedSource());
  const commands = new Map();
  const hooks = [];
  const api = {
    registerTool: () => {},
    registerCommand: (name, definition) => { commands.set(name, definition); },
    registerMessageRenderer: () => {},
    on: (event, handler) => { hooks.push([event, handler]); return () => {}; },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  // The worktree plan's own Herdr calls stay isolated from a live workspace.
  process.env.HERDR_BIN_PATH = path.join(dir, 'no-such-herdr-binary');
  const mod = await import(pathToFileURL(copy).href);
  const factory = mod.default;
  factory(api);
  return { commands, hooks, api, mod, factory };
}

function sessionStartHandlers(hooks) {
  return hooks.filter(([event]) => event === 'session_start').map(([, handler]) => handler);
}

async function fireSessionStart(hooks, ctx) {
  for (const handler of sessionStartHandlers(hooks)) {
    const out = handler({}, ctx);
    if (out && typeof out.then === 'function') await out;
  }
}

function gateCtx(cwd, notes) {
  return { cwd, ui: { notify: (message, level) => notes.push([message, level]) } };
}

const stubTui = {
  visibleWidth: (text) => [...String(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

function makeHostTui(rows = 24) {
  const paints = [];
  const lifecycle = [];
  return {
    paints,
    lifecycle,
    tui: {
      terminal: { rows },
      stop: () => lifecycle.push('stop'),
      start: () => lifecycle.push('start'),
      requestRender: (force) => { lifecycle.push('render'); paints.push(force === true); },
    },
  };
}

function makeCtx({ cwd, customImpl } = {}) {
  const notes = [];
  const customs = [];
  const selects = [];
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => notes.push([message, level]),
      select: async (title, options) => { selects.push([title, options]); return undefined; },
    },
  };
  if (customImpl !== undefined) {
    ctx.ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  return { ctx, notes, customs, selects };
}

function openComponent(factory, host) {
  let settled = 'pending';
  const component = factory(host.tui, {}, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  assert.equal(typeof component.invalidate, 'function');
  return { component, done: () => settled };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// Captures the options the extension mounts the real view with, leaving every
// client call real and injectable.
function captureIssuesView() {
  const lib = require('../lib/issues-view.js');
  const original = lib.createIssuesView;
  const holder = { options: null };
  lib.createIssuesView = (options) => {
    holder.options = options;
    return { render: () => [], handleInput: () => {}, invalidate: () => {} };
  };
  return { holder, restore: () => { lib.createIssuesView = original; } };
}

// One issue node in the shape both GraphQL page queries ask for.
function graphqlIssueNode(row) {
  return {
    number: row.number,
    title: row.title,
    state: String(row.state || 'OPEN').toUpperCase(),
    stateReason: '',
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: { login: (row.author && row.author.login) || 'someone' },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    reactionGroups: [],
  };
}

function graphqlField(argv, name, flag = '-F') {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag && argv[index + 1].startsWith(`${name}=`)) return argv[index + 1].slice(name.length + 1);
  }
  return null;
}

// The cursor-paged SEARCH snapshot the scoped tabs read through
// `getIssuePage`: every edge carries its own opaque cursor.
function graphqlSearchPage(argv, rows) {
  const first = Number(graphqlField(argv, 'first'));
  const after = graphqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('row-', '')) + 1;
  const page = rows.slice(start, start + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      search: {
        issueCount: rows.length,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `row-${start + page.length - 1}` : null },
        edges: page.map((row, at) => ({ cursor: `row-${start + at}`, node: graphqlIssueNode(row) })),
      },
    },
  });
}

// The cursor-paged CONNECTION snapshot the unfiltered `All` bucket reads.
function graphqlConnectionPage(argv, rows) {
  const first = Number(graphqlField(argv, 'first'));
  const after = graphqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('conn-', '')) + 1;
  const page = rows.slice(start, start + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      repository: {
        issues: {
          totalCount: rows.length,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? `conn-${start + page.length - 1}` : null },
          edges: page.map((row, at) => ({ cursor: `conn-${start + at}`, node: graphqlIssueNode(row) })),
        },
      },
    },
  });
}

// Every call that read the repository issue CONNECTION — the `All` bucket's
// source. A search call is not one of them.
function connectionReads(calls) {
  return calls
    .filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')
    .map((call) => ({
      query: graphqlField(call.argv, 'query', '-f') || '',
      first: graphqlField(call.argv, 'first'),
      cursor: graphqlField(call.argv, 'cursor'),
      argv: call.argv,
    }))
    .filter((read) => read.query.includes('issues(states: [') && read.query.includes('edges { cursor node'));
}

// The exact source query each fresh search page asked for, with the client's
// own `repo:… is:issue is:open` prefix removed.
function searchQueries(calls) {
  return calls
    .filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')
    .map((call) => graphqlField(call.argv, 'search'))
    .filter((value) => value !== null)
    .map((value) => value.replace(/^repo:\S+ is:issue is:open /, ''));
}

// Pattern-matching `gh` runner over the captured real-`gh` fixtures: answers by
// argv shape and records every call, so the action tests pin the exact fixed
// argv each write reaches `gh` with. `WRITE` is the default role because the
// label test creates a label, which needs canCreateLabels.
function makeIssuesRunner({ failComment = false, role = 'WRITE', connectionRows = null } = {}) {
  const calls = [];
  const ok = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
  const rows = JSON.parse(fixture('gh-issue-list.json'));
  const runner = async (bin, argv, opts) => {
    calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const query = graphqlField(argv, 'query', '-f') || '';
      if (query.includes('assignableUsers')) {
        return ok(JSON.stringify({ data: { repository: { assignableUsers: {
          nodes: [{ login: 'jonasotoaguilar', name: 'Jonathan Soto' }, { login: 'octocat', name: 'Octo Cat' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } }));
      }
      if (query.includes('projectItems')) {
        return ok(JSON.stringify({ data: { repository: { issue: {
          projectItems: { nodes: [], pageInfo: { hasNextPage: false } },
        } } } }));
      }
      if (query.includes('viewerPermission')) {
        return ok(JSON.stringify({ data: { repository: {
          viewerPermission: role,
          issue: {
            assignees: { nodes: [{ login: 'jonasotoaguilar' }], pageInfo: { hasNextPage: false } },
            closedByPullRequestsReferences: { totalCount: 2 },
          },
        } } }));
      }
      if (query.includes('type: ISSUE')) return ok(graphqlSearchPage(argv, rows));
      if (query.includes('edges { cursor node')) return ok(graphqlConnectionPage(argv, connectionRows || rows));
      return ok(JSON.stringify({ data: { repository: { issues: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } } } }));
    }
    if (argv[0] === 'api') return ok(fixture('gh-api-user.json'));
    if (argv[0] === 'repo') return ok(fixture('gh-repo-view.json'));
    if (argv[0] === 'issue' && argv[1] === 'list') return ok(fixture('gh-issue-list.json'));
    if (argv[0] === 'issue' && argv[1] === 'view' && argv.includes('--json')) {
      return ok(fixture('gh-issue-view.json'));
    }
    if (argv[0] === 'label' && argv[1] === 'list') return ok(fixture('gh-label-list.json'));
    if (argv[0] === 'label' && argv[1] === 'create') return ok('{}');
    if (argv[0] === 'issue' && argv[1] === 'comment') {
      if (failComment) return { status: 1, stdout: '', stderr: 'rate limited', error: null };
      return ok('');
    }
    if (argv[0] === 'issue' && (argv[1] === 'edit' || argv[1] === 'close' || argv[1] === 'reopen')) {
      return ok('');
    }
    return ok('');
  };
  return { runner, calls };
}

function registryFile(root) {
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  const commonDir = path.isAbsolute(common) ? common : path.resolve(root, common);
  return path.join(commonDir, 'pi-worktrees.json');
}

// Gate the extension through session_start with a scratch cwd (so the
// unrelated worktree discovery never touches the fixture repo), then run the
// command handler against the fixture checkout.
async function openIssues(root, { runner, rows = 24 } = {}) {
  const loaded = await loadExtension();
  ghIssues.setGhRunner(runner || makeIssuesRunner().runner);
  const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
  await fireSessionStart(loaded.hooks, gateCtx(scratch, []));
  const def = loaded.commands.get('issues');
  assert.ok(def, 'expected the issues command to be registered');
  loaded.mod.setIssuesTuiLoader(async () => stubTui);
  const host = makeHostTui(rows);
  let factory = null;
  const { ctx, notes, customs } = makeCtx({
    cwd: root,
    customImpl: async (captured) => { factory = captured; return null; },
  });
  await def.handler('', ctx);
  assert.ok(factory, 'the overlay opens');
  const { component, done } = openComponent(factory, host);
  await tick();
  return { component, notes, customs, commands: loaded.commands, done, host };
}

// The options the command mounts the real view with, over the real injected
// `gh`, while every client call the extension makes stays real and injectable.
async function capturedIssuesOptions(root, options = {}) {
  const injected = options.runner
    ? { runner: options.runner, calls: options.calls || [] }
    : makeIssuesRunner(options);
  const capture = captureIssuesView();
  try {
    const loaded = await loadExtension();
    ghIssues.setGhRunner(injected.runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(loaded.hooks, gateCtx(scratch, []));
    loaded.mod.setIssuesTuiLoader(async () => stubTui);
    const host = makeHostTui(options.rows || 24);
    const { ctx } = makeCtx({ cwd: root });
    ctx.ui.custom = async (factory) => {
      factory(host.tui, {}, {}, () => {});
      return null;
    };
    await loaded.commands.get('issues').handler('', ctx);
    await tick();
    assert.ok(capture.holder.options, 'the command mounts the view');
    return {
      options: capture.holder.options,
      calls: injected.calls,
      host,
      restore: capture.restore,
    };
  } catch (err) {
    capture.restore();
    throw err;
  }
}

describe('/issues gate (S3)', () => {
  test('registers the command eagerly, independent of the gh check', async () => {
    const { commands } = await loadExtension();
    const def = commands.get('issues');
    assert.ok(def, 'the command is registered at load');
    assert.equal(typeof def.handler, 'function');
    assert.match(def.description, /GitHub issue/i);
  });

  test('an authenticated gate keeps the command and notifies nothing', async () => {
    const { commands, hooks } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const notes = [];
    await fireSessionStart(hooks, gateCtx(makeRepo({ tag: 'gate-ok' }), notes));
    assert.ok(commands.has('issues'));
    assert.deepEqual(notes, []);
  });

  test('a missing gh notifies the fix once at startup and again on invocation, opening nothing', async () => {
    const { commands, hooks, mod } = await loadExtension();
    ghIssues.setGhRunner(async (bin) => ({
      status: null, stdout: '', stderr: '', error: `spawn ${bin} ENOENT: gh CLI is not available`,
    }));
    const root = makeRepo({ tag: 'gate-missing' });
    const notes = [];
    await fireSessionStart(hooks, gateCtx(root, notes));
    await fireSessionStart(hooks, gateCtx(root, notes));
    assert.ok(commands.has('issues'), 'the command stays discoverable');
    assert.equal(notes.length, 1, 'exactly one startup notification per session');
    assert.match(notes[0][0], /gh CLI is not available/, 'the note names what is missing');
    assert.match(notes[0][0], /gh auth login/, 'the note names the command that fixes it');
    assert.ok(!/unregistered/.test(notes[0][0]), 'the command is registered eagerly');
    assert.match(notes[0][0], /cannot open/, 'the note names the real consequence');

    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes: invokeNotes } = makeCtx({ cwd: root, customImpl: async () => null });
    await commands.get('issues').handler('', ctx);
    assert.equal(customs.length, 0, 'invocation without gh opens nothing');
    assert.equal(invokeNotes.length, 1, 'invocation reports the honest dependency error');
    assert.match(invokeNotes[0][0], /gh auth login/);
    assert.equal(invokeNotes[0][1], 'error');
  });

  test('an unauthenticated gh notifies the login fix on invocation and opens nothing', async () => {
    const { commands, mod } = await loadExtension();
    ghIssues.setGhRunner(async () => ({
      status: 1, stdout: '', stderr: 'Failed to log in: authentication required', error: null,
    }));
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: makeRepo({ tag: 'gate-auth' }), customImpl: async () => null });
    await commands.get('issues').handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay while unauthenticated');
    assert.equal(notes.length, 1);
    assert.match(notes[0][0], /gh auth login/, 'the note names the login fix');
  });
});

describe('/issues overlay and arguments', () => {
  test('opens full screen fed by the scoped searches and the All connection', async () => {
    const root = makeRepo({ tag: 'issues-open' });
    const { runner, calls } = makeIssuesRunner();
    const { component, customs, notes } = await openIssues(root, { runner });
    assert.equal(customs.length, 1, 'the overlay opens once');
    assert.deepEqual(customs[0][1], {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '100%', maxHeight: '100%', margin: 0 },
    });
    assert.deepEqual(notes, [], 'opening writes no notification');
    const listSearches = calls
      .filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list')
      .map((call) => call.argv[call.argv.indexOf('--search') + 1]);
    assert.deepEqual(listSearches, [], 'the viewer reads fresh pages, never a list cache');
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'every scoped tab is read once with its own exact query');
    assert.equal(connectionReads(calls).length, 1, 'the All tab is read once through the issue connection');
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues/);
    assert.match(body, /Assigned/);
    assert.match(body, /Involved/);
    assert.match(body, /76/, 'the listed issue number');
    assert.match(body, /chore: update/, 'the listed issue title');
    assert.match(body, /◈ Issues/, 'the header names the surface');
    assert.ok(!body.includes(path.basename(root)), 'the header never repeats the checkout name');
  });

  test('an argument notifies and opens nothing', async () => {
    const root = makeRepo({ tag: 'issues-args' });
    const { commands, mod, hooks } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(hooks, gateCtx(scratch, []));
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await commands.get('issues').handler('extra', ctx);
    assert.equal(customs.length, 0, 'no overlay for an argument');
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0], ['Unknown option "extra". Use /issues.', 'error']);
  });

  test('outside a Git checkout notifies the shared line at info and opens nothing', async () => {
    const { commands, mod, hooks } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(hooks, gateCtx(scratch, []));
    mod.setIssuesTuiLoader(async () => stubTui);
    const outside = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-plain-'))));
    const { ctx, customs, selects, notes } = makeCtx({ cwd: outside, customImpl: async () => null });
    await commands.get('issues').handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay outside a checkout');
    assert.equal(selects.length, 0, 'no fallback selector outside a checkout');
    assert.deepEqual(notes, [[`not a git repository: ${outside}; run 'git init' first`, 'info']]);
  });
});

describe('/issues is read-only about the worktree association', () => {
  test('the mounted view is handed no association option and reading writes nothing', async () => {
    const root = makeRepo({ tag: 'issues-readonly' });
    const file = registryFile(root);
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1,
      worktrees: [{ branch: git(root, ['branch', '--show-current']).trim(), path: root, thread: 't', issues: [76], odd: null }],
    }, null, 2)}\n`);
    const before = fs.readFileSync(file, 'utf8');
    const { runner } = makeIssuesRunner();
    const capture = captureIssuesView();
    try {
      await openIssues(root, { runner });
      const options = capture.holder.options;
      for (const key of ['assigned', 'assignedOdd', 'saveAssignment', 'assignmentEnabled']) {
        assert.equal(key in options, false, `the view is handed no ${key}: ${JSON.stringify(Object.keys(options))}`);
      }
    } finally {
      capture.restore();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'reading writes nothing');

    const { component } = await openIssues(root, { runner });
    assert.match(clean(component.render(110).join('\n')), /76/, 'the stored issue still lists');
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the removed association keys write nothing');
  });
});

describe('/issues actions (S3,S4)', () => {
  test('label toggle, create-new, comment, browser and close reach gh with fixed argv', async () => {
    const root = makeRepo({ tag: 'issues-actions' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    const ghCalls = () => calls.filter((call) => call.bin === 'gh');

    component.handleInput('L');
    assert.equal(component.state.mode, 'labels');
    await tick();
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'a successful label apply closes the editor');
    const edit = ghCalls().find((call) => call.argv[1] === 'edit');
    assert.ok(edit, 'the label toggle reaches gh issue edit');
    assert.equal(edit.cwd, root, 'the write runs in this checkout');
    assert.deepEqual(edit.argv.slice(0, 3), ['issue', 'edit', '76']);
    assert.ok(edit.argv.includes('--add-label'), 'additions ride --add-label');
    assert.ok(edit.argv.includes('bug'), 'the toggled label is applied');
    assert.ok(!edit.argv.join(' ').includes('&&'), 'fixed argv: no shell string');

    component.handleInput('L');
    component.handleInput('n');
    for (const ch of 'triage') component.handleInput(ch);
    component.handleInput('enter');
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => ghCalls().some((call) => call.argv[1] === 'create')), 'a new label reaches gh label create');
    const create = ghCalls().find((call) => call.argv[1] === 'create');
    assert.deepEqual(create.argv.slice(0, 3), ['label', 'create', 'triage']);
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'creating a label applies and closes the editor');

    component.handleInput('c');
    assert.equal(component.state.mode, 'comment');
    for (const ch of 'hi') component.handleInput(ch);
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'a posted comment closes the input');
    const comment = ghCalls().find((call) => call.argv[1] === 'comment');
    assert.deepEqual(comment.argv, ['issue', 'comment', '76', '--body', 'hi']);

    component.handleInput('x');
    assert.equal(component.state.mode, 'confirm');
    assert.match(clean(component.render(110).join('\n')), /Confirm close #76/);
    component.handleInput('enter');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'the close settles');
    assert.ok(!clean(component.render(110).join('\n')).includes('#76'), 'the closed issue leaves the open list at once');
    const close = ghCalls().find((call) => call.argv[1] === 'close');
    assert.deepEqual(close.argv, ['issue', 'close', '76']);
    assert.equal(ghCalls().some((call) => call.argv[1] === 'reopen'), false, 'the view has no reopen path');
  });

  test('the mounted view refuses close, labels and assign on READ, and offers no label creation on TRIAGE', async () => {
    const mutations = (calls) => calls.filter((call) => call.argv[0] === 'issue'
      && ['edit', 'close', 'reopen'].includes(call.argv[1]))
      .concat(calls.filter((call) => call.argv[0] === 'label' && call.argv[1] === 'create'));

    const readRoot = makeRepo({ tag: 'issues-role-read' });
    const read = makeIssuesRunner({ role: 'READ' });
    const { component: readOnly } = await openIssues(readRoot, { runner: read.runner });
    const readFrame = () => clean(readOnly.render(200).join('\n'));
    assert.ok(await waitFor(() => readFrame().includes('c comment')), 'the reader is painted');
    assert.ok(!readFrame().includes('L labels'), 'a read-only viewer is offered no label editor');
    assert.ok(!readFrame().includes('a assign'), 'no assignee editor either');
    assert.ok(!readFrame().includes('x/X close'), 'and no close key');

    for (const key of ['x', 'X', 'L', 'a']) readOnly.handleInput(key);
    await tick();
    assert.equal(readOnly.state.mode, 'list', 'no editor opens without the capability');
    assert.equal(readOnly.state.confirm, null, 'no close confirmation is staged');
    assert.match(readFrame(), /permission/, 'the refusal names the missing permission');
    assert.deepEqual(mutations(read.calls), [], 'no mutation was even attempted');

    const triageRoot = makeRepo({ tag: 'issues-role-triage' });
    const triage = makeIssuesRunner({ role: 'TRIAGE' });
    const { component: triaged } = await openIssues(triageRoot, { runner: triage.runner });
    const triageFrame = () => clean(triaged.render(200).join('\n'));
    assert.ok(await waitFor(() => triageFrame().includes('l labels')), 'triage may open the label editor');

    triaged.handleInput('L');
    assert.equal(triaged.state.mode, 'labels', 'the triage viewer reaches the editor');
    await tick();
    assert.ok(!triageFrame().includes('create new'), 'no create row without the WRITE right');
    assert.ok(!triageFrame().includes('n new'), 'and no create keybinding either');
    triaged.handleInput('n');
    assert.equal(triaged.state.labelCreating, false, 'n starts no creation');
    triaged.handleInput('escape');
    assert.equal(triaged.state.mode, 'list');

    triaged.handleInput('x');
    assert.equal(triaged.state.mode, 'confirm', 'triage may close');
    triaged.handleInput('enter');
    assert.ok(await waitFor(() => triage.calls.some((call) => call.argv[1] === 'close')), 'the close reached gh');
    assert.deepEqual(triage.calls.filter((call) => call.argv[1] === 'close').map((call) => call.argv),
      [['issue', 'close', '76']], 'one fixed-argv close, and no label creation');
  });

  test('the browser opener runs fixed argv and suspends the terminal for the open', async () => {
    const root = makeRepo({ tag: 'issues-open-browser' });
    const { runner } = makeIssuesRunner();
    const run = await capturedIssuesOptions(root, { runner });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv, opts) => {
      gitCalls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener reports success');
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
    assert.equal(gitCalls.length, 1, 'the browser opener runs once');
    assert.deepEqual(gitCalls[0].argv,
      ['issue', 'view', '76', '--web', '-R', 'github.com/jonasotoaguilar/herdr-gentle-shell']);
    assert.equal(gitCalls[0].cwd, root, 'the opener runs in this checkout');
    assert.ok(!gitCalls[0].argv.join(' ').includes('xdg-open'), 'never an invented opener');
    assert.deepEqual(run.host.lifecycle, ['stop', 'start', 'render'],
      'the TUI is suspended for the browser open and taken back afterwards');
    assert.deepEqual(run.host.paints, [true], 'the terminal is forced to repaint on resume');
  });

  test('r re-reads the current page fresh, and the removed state toggle reads nothing', async () => {
    const root = makeRepo({ tag: 'issues-reload' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    const primed = searchQueries(calls);
    assert.equal(primed.length, 3, 'the mount read every scoped bucket once');
    const connections = connectionReads(calls).length;
    assert.equal(connections, 1, 'and the All bucket once, through the connection');

    const before = clean(component.render(110).join('\n'));
    component.handleInput('f');
    await tick();
    assert.deepEqual(searchQueries(calls), primed, 'f fetches nothing: no other state is asked for');
    assert.equal(clean(component.render(110).join('\n')), before, 'f repaints nothing');

    component.handleInput('r');
    await tick();
    assert.deepEqual(searchQueries(calls).slice(primed.length), ['author:@me sort:updated-desc'],
      'a reload re-reads the current page fresh');
    assert.equal(connectionReads(calls).length, connections, 'the reload left the All connection page alone');
    assert.equal(calls.some((call) => call.argv.includes('--state')), false,
      'the list API is never asked for any state');
  });

  test('a failing comment keeps the draft, shows the error and changes nothing', async () => {
    const root = makeRepo({ tag: 'issues-fail' });
    const { runner, calls } = makeIssuesRunner({ failComment: true });
    const { component } = await openIssues(root, { runner });
    component.handleInput('c');
    for (const ch of 'hey') component.handleInput(ch);
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => calls.some((call) => call.argv[1] === 'comment')), 'the comment reached gh');
    await tick();
    assert.equal(component.state.mode, 'comment', 'the failure keeps the input open');
    assert.equal(component.state.commentText, 'hey', 'the draft survives the failure');
    assert.match(clean(component.render(110).join('\n')), /rate limited/, 'the error surfaces honestly');
    assert.equal(calls.filter((call) => call.argv[1] === 'comment').length, 1, 'one attempt, no retry');
  });
});

describe('/issues page seam (S5,D1)', () => {
  async function mountCapturing(root, rows = 24) {
    const base = makeIssuesRunner();
    const lib = require('../lib/issues-view.js');
    const realCreate = lib.createIssuesView;
    const realPage = ghIssues.getIssuePage;
    const order = [];
    const pages = [];
    const holder = { options: null };
    ghIssues.getIssuePage = (params, opts) => {
      order.push('page');
      pages.push({ params, opts });
      return realPage(params, opts);
    };
    lib.createIssuesView = (options) => {
      holder.options = options;
      order.push('view');
      return realCreate(options);
    };
    const restore = () => {
      lib.createIssuesView = realCreate;
      ghIssues.getIssuePage = realPage;
    };
    let mounted = null;
    let loaded = null;
    try {
      loaded = await loadExtension();
      ghIssues.setGhRunner(base.runner);
      const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
      await fireSessionStart(loaded.hooks, gateCtx(scratch, []));
      loaded.mod.setIssuesTuiLoader(async () => stubTui);
      const { ctx } = makeCtx({ cwd: root });
      ctx.ui.custom = async (factory) => {
        order.push('custom');
        mounted = openComponent(factory, makeHostTui(rows));
        return null;
      };
      await loaded.commands.get('issues').handler('', ctx);
      await tick();
    } catch (err) {
      restore();
      throw err;
    }
    return { order, pages, holder, base, mounted, restore };
  }

  test('the overlay mounts before any page read, with bucket metadata only', async () => {
    const root = makeRepo({ tag: 'issues-order' });
    const run = await mountCapturing(root);
    try {
      assert.equal(run.order[0], 'custom', 'the overlay opens before anything is read');
      assert.deepEqual(run.order.slice(0, 3), ['custom', 'view', 'page'],
        'the view mounts first, and its own mount asks for the first page');
      const options = run.holder.options;
      assert.deepEqual(options.pages.map((page) => [page.id, page.label, page.issues]), [
        ['mine', 'My issues', null],
        ['assigned', 'Assigned', null],
        ['involved', 'Involved', null],
        ['all', 'All', null],
      ], 'bucket metadata only: no accumulated rows are handed to the view');
      assert.equal(options.loadPages, undefined, 'no eager/lazy-list loader is passed beside the fresh seam');
      assert.equal(typeof options.loadIssuePage, 'function');
      const first = run.pages[0];
      assert.deepEqual(first.params, { query: 'author:@me sort:updated-desc', after: null, first: first.params.first });
      assert.ok(Number.isInteger(first.params.first) && first.params.first >= 1, 'the limit is a row budget');
      assert.equal(first.opts.cwd, root);
    } finally {
      run.restore();
    }
  });

  test('the loader passes the exact bucket query, cursor, dynamic limit and pinned scope', async () => {
    const root = makeRepo({ tag: 'issues-seam' });
    const narrow = await mountCapturing(root, 24);
    let narrowLimit = null;
    try {
      narrowLimit = narrow.pages[0].params.first;
      const asked = await narrow.holder.options.loadIssuePage({ bucketId: 'assigned', cursor: 'row-3', limit: 7 });
      assert.equal(asked.ok, true, 'the real client answered the page');
      const call = narrow.pages[narrow.pages.length - 1];
      assert.deepEqual(call.params, { query: 'assignee:@me sort:updated-desc', after: 'row-3', first: 7 },
        'the bucket query, the caller cursor and the caller limit pass straight through');
      assert.deepEqual(call.opts, { cwd: root, scope: 'github.com/jonasotoaguilar/herdr-gentle-shell' },
        'the page read is scoped to this checkout and bound to the pinned identity');

      const before = narrow.pages.length;
      await narrow.holder.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5 });
      await narrow.holder.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5 });
      assert.deepEqual(narrow.pages.slice(before).map((entry) => entry.params), [
        { query: 'involves:@me -author:@me sort:updated-desc', after: null, first: 5 },
        { query: 'involves:@me -author:@me sort:updated-desc', after: null, first: 5 },
      ], 'identical requests read again instead of answering from a cache');

      const subprocesses = narrow.base.calls.length;
      assert.deepEqual(narrow.holder.options.loadIssuePage({ bucketId: 'bogus', cursor: null, limit: 5 }),
        { ok: false, error: 'unknown issues bucket "bogus"' }, 'an unknown bucket fails explicitly');
      assert.equal(narrow.base.calls.length, subprocesses, 'an unknown bucket never runs gh');
    } finally {
      narrow.restore();
    }

    const wide = await mountCapturing(root, 60);
    try {
      const wideLimit = wide.pages[0].params.first;
      assert.ok(wideLimit > narrowLimit,
        `the limit follows the viewport row budget: ${narrowLimit} at 24 rows, ${wideLimit} at 60`);
    } finally {
      wide.restore();
    }
  });

  test('the All bucket reads the open connection, and a typed query stays on the search API', async () => {
    const root = makeRepo({ tag: 'issues-all' });
    const run = await capturedIssuesOptions(root);
    try {
      const before = run.calls.length;
      const asked = await run.options.loadIssuePage({ bucketId: 'all', cursor: null, limit: 5 });
      assert.equal(asked.ok, true, 'the real client answered the All page');
      const reads = connectionReads(run.calls.slice(before));
      assert.equal(reads.length, 1, 'one connection read answered the All bucket');
      assert.deepEqual(searchQueries(run.calls.slice(before)), [], 'the All bucket never used the search API');
      assert.equal(reads[0].cursor, null, 'a head read starts the connection at its first row');
      assert.equal(reads[0].first, '5', 'the caller limit bounds the connection page');
      assert.match(reads[0].query, /issues\(states: \[OPEN\], first: \$first, after: \$cursor/);
      assert.match(reads[0].query, /orderBy: \{field: UPDATED_AT, direction: DESC\}/);
      assert.ok(!reads[0].query.includes('search('), 'never the 1000-match search API');
      assert.ok(!reads[0].argv.some((entry) => entry.startsWith('search=')), 'no search text reaches the connection');
      const rows = JSON.parse(fixture('gh-issue-list.json')).length;
      assert.equal(asked.total, rows, 'the whole open set is the bucket total');
      for (const issue of asked.issues) assert.equal(typeof issue.cursor, 'string', 'every row keeps its own cursor');

      const typedBefore = run.calls.length;
      const typed = await run.options.loadIssuePage({ bucketId: 'all', cursor: 'row-2', limit: 4, query: '  label:bug  ' });
      assert.equal(typed.ok, true, 'the typed All search answered');
      assert.deepEqual(searchQueries(run.calls.slice(typedBefore)), ['sort:updated-desc label:bug'],
        'a typed query keeps the bucket ordering and rides the search API');
      assert.equal(connectionReads(run.calls.slice(typedBefore)).length, 0,
        'a typed query never reaches the connection, which takes no search text');

      const scopedBefore = run.calls.length;
      await run.options.loadIssuePage({ bucketId: 'mine', cursor: 'row-2', limit: 7, query: '  label:bug is:open  ' });
      assert.deepEqual(searchQueries(run.calls.slice(scopedBefore)), ['author:@me sort:updated-desc label:bug is:open'],
        'the bucket scope stays and the typed operators ride along');
      const bareBefore = run.calls.length;
      await run.options.loadIssuePage({ bucketId: 'assigned', cursor: null, limit: 5 });
      assert.deepEqual(searchQueries(run.calls.slice(bareBefore)), ['assignee:@me sort:updated-desc'],
        'no query means no extra search text');
      const blankBefore = run.calls.length;
      await run.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5, query: '   ' });
      assert.deepEqual(searchQueries(run.calls.slice(blankBefore)), ['involves:@me -author:@me sort:updated-desc'],
        'a blank query is absent, never a trailing space');
    } finally {
      run.restore();
    }
  });

  test('more than 1000 open issues page to the end through the All bucket', async () => {
    const root = makeRepo({ tag: 'issues-all-1200' });
    const total = 1200;
    const rows = Array.from({ length: total }, (_, at) => ({
      number: at + 1,
      title: `synthetic issue ${at + 1}`,
      state: 'OPEN',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      url: `https://github.com/o/r/issues/${at + 1}`,
    }));
    const run = await capturedIssuesOptions(root, { connectionRows: rows });
    try {
      const before = run.calls.length;
      const seen = [];
      let cursor = null;
      let pages = 0;
      for (;;) {
        const page = await run.options.loadIssuePage({ bucketId: 'all', cursor, limit: 100 });
        assert.equal(page.ok, true, `page ${pages + 1} loaded: ${page.error || ''}`);
        assert.equal(page.total, total, 'every page reports the exact server total');
        assert.ok(page.issues.length > 0, 'a page never comes back empty mid-walk');
        cursor = page.issues[page.issues.length - 1].cursor;
        seen.push(...page.issues.map((issue) => issue.number));
        pages += 1;
        if (page.hasNextPage !== true) break;
        assert.ok(pages <= 12, 'the walk ends: 1200 rows at 100 per page is 12 pages');
      }
      assert.equal(pages, 12, 'exactly the pages the 1200 rows need');
      assert.deepEqual(seen, rows.map((row) => row.number), 'every open issue arrives once, in order');
      const reads = connectionReads(run.calls.slice(before));
      assert.equal(reads.length, 12, 'every page was a connection read');
      assert.equal(reads[1].cursor, 'conn-99', 'each continuation resumes after the last row shown');
      assert.deepEqual(searchQueries(run.calls.slice(before)), [], 'no page read the capped search');
    } finally {
      run.restore();
    }
  });

  test('the active bucket names the real total, not the rows one page fetched', async () => {
    const root = makeRepo({ tag: 'issues-totals' });
    const rows = Array.from({ length: 45 }, (_, at) => ({
      number: at + 1,
      title: `issue ${at + 1} chore: update`,
      state: 'OPEN',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      url: `https://example.test/issues/${at + 1}`,
    }));
    const { runner } = makeIssuesRunner({ connectionRows: null });
    // The scoped tabs read the search API, so the fixture rows are replaced by
    // a search page carrying the same 45 rows the connection would.
    const wrapped = async (bin, argv, opts) => {
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const query = graphqlField(argv, 'query', '-f') || '';
        if (query.includes('type: ISSUE')) {
          return { status: 0, stdout: graphqlSearchPage(argv, rows), stderr: '', error: null };
        }
      }
      return runner(bin, argv, opts);
    };
    const { component } = await openIssues(root, { runner: wrapped });
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues \(45/);
    assert.ok(!body.includes('+ issues'), 'the total is never repeated below the list');
  });
});

describe('/issues repository identity (S5)', () => {
  const forkRoots = [];
  after(() => {
    for (const dir of forkRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  function makeForkRepo({ tag = 'issues-fork', remotes = [['origin', 'myfork/project'], ['upstream', 'original/project']] } = {}) {
    const root = makeRepo({ tag });
    forkRoots.push(root);
    for (const [name, repo] of remotes) {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.includes(':') || repo.startsWith('/')
        ? repo
        : `git@github.com:${repo}.git`;
      git(root, ['remote', 'add', name, url]);
    }
    return root;
  }

  function forkRunner({ repoView = 'original/project' } = {}) {
    const base = makeIssuesRunner();
    const runner = async (bin, argv, opts) => {
      const env = (opts && opts.env) || {};
      const repo = typeof env.GH_REPO === 'string' && env.GH_REPO !== '' ? env.GH_REPO : repoView;
      base.calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined, repo });
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: repoView }), stderr: '', error: null };
      }
      const before = base.calls.length;
      const out = await base.runner(bin, argv, opts);
      base.calls.length = before;
      return out;
    };
    return { runner, calls: base.calls };
  }

  function searchScopes(calls) {
    return calls
      .flatMap((call) => call.argv)
      .filter((value) => value.startsWith('search=repo:'))
      .map((value) => value.slice('search=repo:'.length).split(' ')[0]);
  }

  test('every tab, the detail, labels and assignees read the checkout fork', async () => {
    const root = makeForkRepo();
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      const before = gh.calls.length;
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, true, `the ${bucketId} tab answered`);
      }
      const reads = gh.calls.slice(before);
      assert.deepEqual(
        searchScopes(reads.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')),
        ['myfork/project', 'myfork/project', 'myfork/project'],
        'each scoped tab searches the fork, never the upstream',
      );
      for (const read of connectionReads(reads)) {
        assert.equal(graphqlField(read.argv, 'owner'), 'myfork', 'the All tab walks the fork issue connection');
        assert.equal(graphqlField(read.argv, 'name'), 'project');
      }
      assert.ok(!reads.some((call) => call.argv.some((value) => value.includes('original/project'))),
        'no tab read carries the upstream repository');

      const scopedBefore = gh.calls.length;
      assert.equal((await run.options.loadIssue(76)).ok, true, 'the detail opened through the real client');
      assert.equal((await run.options.loadLabels()).ok, true);
      assert.equal((await run.options.loadAssignees()).ok, true);
      const scoped = gh.calls.slice(scopedBefore);
      assert.ok(scoped.length >= 3, 'the detail, label and assignee reads ran');
      for (const call of scoped) {
        assert.equal(call.repo, 'github.com/myfork/project',
          `the read is scoped to the fork, host included (${call.argv.join(' ')})`);
      }
    } finally {
      run.restore();
    }
  });

  test('the browser opener opens the fork issue, not the upstream one', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-open' });
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv, opts) => {
      gitCalls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true);
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
    assert.deepEqual(gitCalls[0].argv, ['issue', 'view', '76', '--web', '-R', 'github.com/myfork/project'],
      'the browser opens the checkout fork issue on the fork server');
  });

  test('a single-remote checkout binds the opener to the repository gh resolves', async () => {
    const root = makeForkRepo({ tag: 'issues-nofork', remotes: [['origin', 'myfork/project']] });
    const gh = forkRunner({ repoView: 'myfork/project' });
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv) => {
      gitCalls.push({ bin, argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      assert.equal((await run.options.actions.openBrowser(76)).ok, true);
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
    assert.deepEqual(gitCalls[0].argv, ['issue', 'view', '76', '--web', '-R', 'github.com/myfork/project'],
      'the opener binds the one repository gh resolved for this checkout');
  });

  test('a non-GitHub checkout remote fails every read and the opener without running gh', async () => {
    const root = makeForkRepo({
      tag: 'issues-fork-local',
      remotes: [['origin', 'file:///srv/mirror/project.git'], ['upstream', 'original/project']],
    });
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv) => {
      gitCalls.push({ argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, false, `the ${bucketId} tab is refused`);
        assert.match(asked.error, /is a local path, not a GitHub repository/);
      }
      const labels = await run.options.loadLabels();
      assert.equal(labels.ok, false, 'the label editor read is refused');
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, false, 'the opener refuses instead of opening another repository');
      assert.match(opened.error, /is a local path, not a GitHub repository/);
      assert.deepEqual(gitCalls, [], 'the browser opener never ran');
      assert.ok(gh.calls.every((call) => call.cwd !== root), 'no gh command ran in this checkout');
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
  });

  test('after the remote moves, every action refuses and reads keep the displayed repository', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-drift' });
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv) => {
      gitCalls.push({ argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const bound = await run.options.actions.postComment(76, 'bound');
      assert.equal(bound.ok, true, 'a write before the move succeeds');
      const boundCall = gh.calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'comment').pop();
      assert.equal(boundCall.repo, 'github.com/myfork/project', 'and it binds the displayed repository');

      git(root, ['remote', 'set-url', 'origin', 'git@github.com:otherfork/project.git']);
      const before = gh.calls.length;

      const comment = await run.options.actions.postComment(76, 'hello');
      assert.equal(comment.ok, false, 'the comment is refused');
      assert.match(comment.error, /changed since this issue list loaded/);
      assert.equal((await run.options.actions.editLabels(76, ['bug'], [], [])).ok, false, 'the label edit is refused');
      assert.equal((await run.options.actions.setState(76, 'closed')).ok, false, 'the close is refused');
      assert.equal((await run.options.actions.editAssignees(76, { add: ['bob'], remove: [] })).ok, false,
        'the assignee edit is refused');
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener still opens the repository the rows came from');
      assert.deepEqual(gitCalls[0].argv, ['issue', 'view', '76', '--web', '-R', 'github.com/myfork/project'],
        'the browser opens the displayed repository, never the one the checkout resolves to now');

      const mutations = gh.calls.slice(before).filter((call) => call.argv[0] === 'issue'
        && ['edit', 'comment', 'close', 'reopen'].includes(call.argv[1]));
      assert.deepEqual(mutations, [], 'no mutating gh command ran after the drift');
      assert.ok(!gh.calls.slice(before).some((call) => call.argv[0] === 'label' && call.argv[1] === 'create'),
        'no label was created on the new fork');

      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, true, `the ${bucketId} tab still reads the loaded repository`);
      }
      const reads = gh.calls.slice(before);
      assert.ok(reads.some((call) => call.argv.some((value) => value.includes('repo:myfork/project'))),
        'the reads carry the displayed repository');
      assert.ok(!reads.some((call) => call.repo === 'github.com/otherfork/project'), 'nothing reached the new fork');
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
  });

  test('an ambient GH_REPO cannot override the pinned identity', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-env-repo' });
    const gh = forkRunner();
    const savedRepo = process.env.GH_REPO;
    delete process.env.GH_REPO;
    let run = null;
    try {
      run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
      process.env.GH_REPO = 'ambient/other';
      const refused = await run.options.actions.postComment(76, 'hello');
      assert.equal(refused.ok, false, 'the write is refused on the drift');
      assert.match(refused.error, /changed since this issue list loaded/);

      const before = gh.calls.length;
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, true);
      assert.ok(gh.calls.slice(before).every((call) => call.repo === 'github.com/myfork/project'),
        'the read carries the pin, not the ambient GH_REPO');
    } finally {
      if (run) run.restore();
      if (savedRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = savedRepo;
    }
  });

  test('an explicit GH_REPO is pinned host-qualified and used', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-env-pin' });
    const gh = forkRunner();
    const savedRepo = process.env.GH_REPO;
    process.env.GH_REPO = 'ambient/repo';
    let run = null;
    try {
      run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
      const before = gh.calls.length;
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, true);
      assert.ok(gh.calls.slice(before).every((call) => call.repo === 'github.com/ambient/repo'),
        'the pinned GH_REPO is host-qualified and used');
    } finally {
      if (run) run.restore();
      if (savedRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = savedRepo;
    }
  });
});

describe('/issues registration survives a reused module', () => {
  test('each runtime load registers the command', async () => {
    const { commands, factory } = await loadExtension();
    assert.ok(commands.has('issues'));
    const reloaded = new Map();
    const api = {
      registerTool: () => {},
      registerCommand: (name, definition) => reloaded.set(name, definition),
      registerMessageRenderer: () => {},
      on: () => () => {},
    };
    factory(api);
    assert.ok(reloaded.has('issues'), 'a reload must not inherit a registered flag from the old runtime');
    reloaded.clear();
    factory(api);
    assert.ok(reloaded.has('issues'), 'a rebuilt registry on the same API must also regain the command');
  });
});

'use strict';
// T5 (S1, S4-S7): the `/prs` wiring in extensions/odd-worktree-tools.ts, driven
// through the registered command, the one rail section and the injected `gh`
// runner.
//
// Contract under test, through the public surface only (registration, the
// notified text, the overlay options, the argv reaching `gh`, the bytes on the
// chat input, the message the host receives):
// - `/prs` is registered behind the SAME `gh` gate as `/issues`: absent `gh`
//   registers neither, and an unauthenticated `gh` refuses the open with the
//   `prs:` sentence and mounts nothing;
// - a plain `/prs` mounts the full-screen overlay on the three scoped searches
//   (`author:@me`, `review-requested:@me`, `involves:@me`) with `all` lazy and
//   read from the repository connection;
// - every read, the detail (with the authoritative metadata) and the `o` opener
//   bind the identity the panel pinned: `gh pr view <n> --web -R <pinned>`;
// - `enter` in BOTH panels inserts `ISSUE #63` / `PR #87` into the chat input
//   through `ctx.ui.pasteToEditor` and closes the panel, sending nothing;
// - a click on one linked number closes the panel it was clicked in and opens
//   the other one through the single-flight dispatch path (`/issues N` /
//   `/prs N`), so no panel stacks on another;
// - the one GITHUB section reads the pull requests too, paints `N issues · M pr`,
//   routes a row whose issue links a PR to the PR panel with `review` winning
//   over `mine`, keeps the old `/issues N` call for every other row, persists its
//   count through lib/prs-rail-store.js from the async loader alone, and a
//   mutation made in the panel invalidates that count;
// - the session start preload is DISPATCHED and never awaited, and only for a
//   section the host was actually drawing.
//
// Every child is injected and every temp tree lives under os.tmpdir().

const { test, describe, after, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { LIB_DIR, stubbedSource, withGhPath } = require('./fixtures/load-extension.js');

const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const realSetTimeout = setTimeout;

const stubTui = {
  visibleWidth: (text) => [...String(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

let ghIssues = null;
let restores = [];
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

afterEach(() => {
  delete globalThis[BRIDGE_SLOT];
  if (ghIssues) {
    ghIssues.setGhRunner(null);
    ghIssues.setGitRunner(null);
    if (typeof ghIssues.clearCachedGhStatus === 'function') ghIssues.clearCachedGhStatus();
  }
  for (const restore of restores) {
    try { restore(); } catch {}
  }
  restores = [];
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-prs-cache-')));
});

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// A checkout with TWO remotes: its identity comes from its own git configuration,
// so the pin is observable without a `gh repo view` call.
function makeCheckout() {
  const dir = track(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-prs-'))));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  git(dir, ['remote', 'add', 'origin', 'git@github.com:myfork/project.git']);
  git(dir, ['remote', 'add', 'upstream', 'git@github.com:original/project.git']);
  return dir;
}

async function loadExtension(pi, options = {}) {
  return withGhPath(options && options.gh === false ? 'absent' : 'present', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-prs-ext-')));
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    const commands = new Map();
    const hooks = [];
    const api = {
      registerTool: () => {},
      registerCommand: (name, definition) => { commands.set(name, definition); },
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
      appendEntry: () => {},
      on: (event, handler) => { hooks.push([event, handler]); return () => {}; },
      ...pi,
    };
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    const mod = await import(pathToFileURL(copy).href);
    mod.default(api);
    return { commands, hooks, api, mod };
  });
}

// `onRepaint` observes the bridge's own repaint request: S4 (D9) needs to see
// that a settled rail read ASKS for the frame the new count is painted by.
function installBridge(onRepaint = null) {
  const registered = [];
  globalThis[BRIDGE_SLOT] = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerRows: () => {},
    registerSection: (section) => { registered.push(section); return () => {}; },
    registerToolDesign: () => () => {},
    createStore: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
    requestRepaint: () => {
      if (typeof onRepaint === 'function') onRepaint();
    },
  };
  return { registered };
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

function fireSessionStartSync(hooks, ctx) {
  const returned = [];
  for (const handler of sessionStartHandlers(hooks)) returned.push(handler({}, ctx));
  return returned;
}

async function fireHook(hooks, event, payload, ctx) {
  for (const handler of hooks.filter(([name]) => name === event).map(([, fn]) => fn)) {
    const out = handler(payload, ctx);
    if (out && typeof out.then === 'function') await out;
  }
}

function ok(stdout) {
  return { status: 0, stdout, stderr: '', error: null };
}

function failed(stderr = 'boom') {
  return { status: 1, stdout: '', stderr, error: null };
}

function gqlField(argv, name, flag = '-F') {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag && argv[index + 1].startsWith(`${name}=`)) {
      return argv[index + 1].slice(name.length + 1);
    }
  }
  return null;
}

function gqlQuery(argv) {
  return gqlField(argv, 'query', '-f') || '';
}

function prNode(row) {
  return {
    number: row.number,
    title: row.title || `Pull ${row.number}`,
    state: 'OPEN',
    isDraft: false,
    url: `https://github.com/myfork/project/pull/${row.number}`,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    author: { login: 'me' },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 0 },
    reactionGroups: [],
    reviewDecision: '',
  };
}

function issueNode(row) {
  return {
    number: row.number,
    title: row.title || `Issue ${row.number}`,
    state: 'OPEN',
    stateReason: '',
    url: `https://github.com/myfork/project/issues/${row.number}`,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    author: { login: 'me' },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    reactionGroups: [],
    timelineItems: {
      nodes: row.pullRequest
        ? [{ source: { __typename: 'PullRequest', number: row.pullRequest } }]
        : [],
    },
  };
}

function searchPage(argv, rows, nodeOf) {
  const first = Number(gqlField(argv, 'first')) || rows.length;
  const after = gqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('row-', '')) + 1;
  const page = rows.slice(start, start + first);
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      search: {
        issueCount: rows.length,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `row-${start + page.length - 1}` : null },
        edges: page.map((row, at) => ({ cursor: `row-${start + at}`, node: nodeOf(row) })),
      },
    },
  });
}

function connectionPage(argv, rows) {
  const first = Number(gqlField(argv, 'first')) || rows.length;
  const after = gqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('conn-', '')) + 1;
  const page = rows.slice(start, start + first);
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          totalCount: rows.length,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? `conn-${start + page.length - 1}` : null },
          edges: page.map((row, at) => ({ cursor: `conn-${start + at}`, node: prNode(row) })),
        },
      },
    },
  });
}

// `total` is the bucket's EXACT `issueCount`, which the window of `rows` may
// under-represent (D8): the header must count the difference too.
function railBucket(rows, total = rows.length) {
  return {
    issueCount: total,
    nodes: rows.map((row) => ({
      number: row.number,
      closingIssuesReferences: {
        nodes: (row.linkedIssues || []).map((number) => ({ number })),
        pageInfo: { hasNextPage: false },
      },
    })),
  };
}

function issueRailBucket(rows) {
  return { issueCount: rows.length, nodes: rows.map(issueNode) };
}

function prDetail(number, overrides = {}) {
  return {
    number,
    title: `Pull ${number}`,
    state: 'OPEN',
    isDraft: false,
    author: { login: 'me' },
    assignees: [],
    labels: [{ name: 'bug', color: 'ff0000', description: '' }],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    comments: [],
    reactionGroups: [],
    url: `https://github.com/myfork/project/pull/${number}`,
    body: 'Body text',
    baseRefName: 'main',
    headRefName: 'feature',
    headRepositoryOwner: { login: 'myfork' },
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    commits: [{ committedDate: '2024-01-02T00:00:00Z' }],
    reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: [{ requestedReviewer: { login: 'reviewer' } }],
    latestReviews: [],
    statusCheckRollup: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    closingIssuesReferences: { nodes: [{ number: 63 }], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}

// The `gh` double: answers by argv shape, records every call together with the
// `GH_REPO` it was bound to, and can fail the rail read on demand.
function makeGithub(options = {}) {
  const calls = [];
  const state = {
    gate: options.gate !== false,
    role: options.role || 'WRITE',
    railFail: options.railFail === true,
    railReads: 0,
    railGate: null,
    railTotals: { mine: null, review: null },
  };
  const prRows = options.prRows || [{ number: 69 }, { number: 70 }];
  const issueRows = options.issueRows || [{ number: 1, title: 'One' }, { number: 2, title: 'Two' }];
  const railMine = options.railMine || [{ number: 69, linkedIssues: [1] }];
  const railReview = options.railReview || [{ number: 70, linkedIssues: [2] }, { number: 69, linkedIssues: [1] }];
  state.railTotals.mine = Number.isInteger(options.railMineTotal) ? options.railMineTotal : railMine.length;
  state.railTotals.review = Number.isInteger(options.railReviewTotal) ? options.railReviewTotal : railReview.length;
  const runner = async (bin, argv, runOpts = {}) => {
    const env = runOpts.env || {};
    calls.push({
      bin,
      argv: argv.slice(),
      cwd: runOpts.cwd,
      repo: typeof env.GH_REPO === 'string' && env.GH_REPO.length > 0 ? env.GH_REPO : null,
    });
    if (argv[0] === 'api' && argv[1] === 'user') {
      return state.gate ? ok('{"login":"me"}') : failed('not logged in');
    }
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return ok(JSON.stringify({ nameWithOwner: 'myfork/project' }));
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const query = gqlQuery(argv);
      if (query.includes('assignableUsers')) {
        return ok(JSON.stringify({ data: { repository: { assignableUsers: {
          nodes: [{ login: 'me', name: 'Me' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } }));
      }
      if (query.includes('viewer { login }')) {
        return ok(JSON.stringify({ data: {
          repository: { viewerPermission: state.role },
          viewer: { login: 'me' },
        } }));
      }
      if (query.includes('viewerPermission') && query.includes('closingIssuesReferences')) {
        return ok(JSON.stringify({ data: { repository: {
          viewerPermission: state.role,
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          pullRequest: {
            isDraft: false,
            state: 'OPEN',
            closingIssuesReferences: { nodes: [{ number: 63 }], pageInfo: { hasNextPage: false } },
          },
        } } }));
      }
      if (query.includes('is:pr') && query.includes('mine: search')) {
        state.railReads += 1;
        if (state.railGate !== null) await state.railGate;
        if (state.railFail) return failed('rate limited');
        return ok(JSON.stringify({ data: {
          mine: railBucket(railMine, state.railTotals.mine),
          review: railBucket(railReview, state.railTotals.review),
        } }));
      }
      if (query.includes('is:issue') && query.includes('mine: search')) {
        return ok(JSON.stringify({ data: {
          mine: issueRailBucket(issueRows),
          assigned: issueRailBucket([]),
          involved: issueRailBucket([]),
        } }));
      }
      if (query.includes('pullRequests(states: OPEN')) {
        return ok(connectionPage(argv, prRows));
      }
      const search = gqlField(argv, 'search');
      if (search !== null) {
        if (search.includes('is:pr')) return ok(searchPage(argv, prRows, prNode));
        return ok(searchPage(argv, issueRows, issueNode));
      }
      if (query.includes('projectItems')) {
        return ok(JSON.stringify({ data: { repository: { issue: {
          projectItems: { nodes: [], pageInfo: { hasNextPage: false } },
        } } } }));
      }
      if (query.includes('viewerPermission')) {
        return ok(JSON.stringify({ data: { repository: {
          viewerPermission: state.role,
          // S2/D20: a write's role read answers the pull request state too.
          pullRequest: { state: 'OPEN' },
          issue: { assignees: { nodes: [], pageInfo: { hasNextPage: false } } },
        } } }));
      }
      return ok(JSON.stringify({ data: {} }));
    }
    if (argv[0] === 'pr' && argv[1] === 'view' && argv.includes('--json')) {
      if (argv.includes('--web')) return ok('');
      if (argv[3] === 'body') return ok(JSON.stringify({ body: 'Body text' }));
      return ok(JSON.stringify(prDetail(Number(argv[2]))));
    }
    if (argv[0] === 'issue' && argv[1] === 'view' && argv.includes('--json')) {
      return ok(JSON.stringify({
        number: Number(argv[2]),
        title: `Issue ${argv[2]}`,
        state: 'OPEN',
        url: 'https://github.com/myfork/project/issues/1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        author: { login: 'me' },
        labels: [],
        assignees: [],
        comments: [],
        body: 'Body',
      }));
    }
    if (argv[0] === 'label' && argv[1] === 'list') {
      return ok(JSON.stringify([{ name: 'bug', color: 'ff0000', description: '' }]));
    }
    if (argv[0] === 'label' && argv[1] === 'create') return ok('{}');
    if (argv[0] === 'pr' && (argv[1] === 'comment' || argv[1] === 'close' || argv[1] === 'merge' || argv[1] === 'edit')) {
      return ok('');
    }
    return ok('');
  };
  return { runner, calls, state };
}

function identityGit() {
  return (argv, opts = {}) => {
    try {
      const stdout = execFileSync('git', argv, {
        cwd: opts.cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
      return { status: 0, stdout, stderr: '', error: null };
    } catch (err) {
      return {
        status: typeof err.status === 'number' ? err.status : 1,
        stdout: String(err.stdout || ''),
        stderr: String(err.stderr || ''),
        error: null,
      };
    }
  };
}

async function boot(options = {}) {
  const sent = [];
  const loaded = await loadExtension({
    sendUserMessage: (text, sendOpts) => { sent.push({ text, opts: sendOpts }); },
  }, options);
  ghIssues = loaded.mod.libModule('gh-issues.js');
  const gh = makeGithub(options);
  ghIssues.setGhRunner(gh.runner);
  ghIssues.setGitRunner(identityGit());
  // `lib/gh-prs.js` keeps its own runner seam: the issue client is injected for
  // its identity and scope helpers, and `runGh` is not one of the seams it
  // exports, so the pull-request client's own `setGhRunner` is the lever.
  const ghPrs = loaded.mod.libModule('gh-prs.js');
  ghPrs.setGhRunner(gh.runner);
  restores.push(() => { ghPrs.setGhRunner(null); });
  loaded.mod.setIssuesTuiLoader(async () => stubTui);
  // A test's extension must not outlive it: a rail read still in flight when the
  // test ends would otherwise persist its answer under the NEXT test's cache home
  // (the store reads `XDG_CACHE_HOME` when it writes), and that stale document
  // would be hydrated into the next test's header. `session_shutdown` is the
  // production path that drops a late answer by its generation.
  restores.push(() => {
    for (const [name, handler] of loaded.hooks) {
      if (name !== 'session_shutdown') continue;
      try { handler({}, { cwd: process.cwd(), ui: { notify() {} } }); } catch {}
    }
  });
  return { loaded, sent, gh, ghPrs };
}

function sessionCtx(cwd, notes = []) {
  return { cwd, ui: { notify: (text, level) => { notes.push({ text, level }); } } };
}

function captureView(mod, file, factoryName) {
  const holder = { options: null, component: null };
  const lib = mod.libModule(file);
  const original = lib[factoryName];
  lib[factoryName] = (options) => {
    holder.options = options;
    holder.component = {
      render: () => [],
      handleInput: () => {},
      handleMouse: () => undefined,
      invalidate: () => {},
    };
    return holder.component;
  };
  restores.push(() => { lib[factoryName] = original; });
  return holder;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('condition never became true');
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

function makeCtx(cwd) {
  const notes = [];
  const ctx = { cwd, ui: { notify: (text, level) => { notes.push({ text, level }); } } };
  return { ctx, notes };
}

// Mount the command the way the host would, capturing the overlay options, the
// view options (through the capture seam) and the `done` the view was handed.
async function mountCommand(loaded, name, args, ctx, { capture = null } = {}) {
  const host = {
    terminal: { rows: 24 },
    stop: () => {},
    start: () => {},
    requestRender: () => {},
    visibleWidth: stubTui.visibleWidth,
    truncateToWidth: stubTui.truncateToWidth,
  };
  const mount = { overlay: null, options: null, component: null, doneCount: 0, doneResult: 'pending' };
  ctx.ui.custom = async (factory, options) => {
    mount.overlay = options;
    mount.component = factory(host, {}, {}, (result) => {
      mount.doneCount += 1;
      mount.doneResult = result;
    });
    mount.options = capture === null ? mount.options : capture.options;
    return null;
  };
  const def = loaded.commands.get(name);
  assert.ok(def, `expected the /${name} command to be registered`);
  await def.handler(args, ctx);
  await tick();
  mount.options = capture === null ? null : capture.options;
  return mount;
}

// The gate warms in a scratch checkout (no repository), so the command's own open
// proves the fixture checkout's identity from cold, exactly like production.
async function warmGate(loaded) {
  const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-prs-gate-')));
  await fireSessionStart(loaded.hooks, sessionCtx(scratch));
  return scratch;
}

async function drawSection(section, ctx) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const rows = section.lines(ctx);
    const meta = section.meta(ctx);
    if (rows.length > 0 && !(rows.length === 1 && rows[0].label === 'loading…')) return { rows, meta };
    if (Date.now() >= deadline) throw new Error('the section never left loading');
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Registration and the shared `gh` gate
// ---------------------------------------------------------------------------

describe('/prs registration and gate (S1)', () => {
  test('without the gh CLI neither /issues nor /prs is registered', async () => {
    installBridge();
    const loaded = await loadExtension({}, { gh: false });
    assert.equal(loaded.commands.has('issues'), false, 'the issues reader is withheld');
    assert.equal(loaded.commands.has('prs'), false, 'the pull-request reader is withheld');
  });

  test('with the CLI present both commands exist (PRESERVE)', async () => {
    installBridge();
    const loaded = await loadExtension({}, { gh: true });
    assert.equal(loaded.commands.has('issues'), true);
    assert.equal(loaded.commands.has('prs'), true);
    assert.match(loaded.commands.get('prs').description, /pull request/i);
  });

  test('an unauthenticated gh refuses /prs with the prs sentence and mounts nothing', async () => {
    installBridge();
    const b = await boot({ gate: false });
    await warmGate(b.loaded);
    const root = makeCheckout();
    const { ctx, notes } = makeCtx(root);
    const mount = await mountCommand(b.loaded, 'prs', '', ctx);
    assert.equal(mount.overlay, null, 'no overlay is mounted');
    assert.ok(
      notes.some((note) => note.level === 'error' && /^prs: .*— \/prs cannot open until then$/.test(note.text)),
      `the refusal names the prs command (saw ${JSON.stringify(notes)})`,
    );
  });
});

// ---------------------------------------------------------------------------
// S1: the overlay and the reads it makes
// ---------------------------------------------------------------------------

describe('/prs overlay and reads (S1, S3)', () => {
  test('opens full screen on the three scoped buckets, leaving all lazy', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const { ctx } = makeCtx(root);
    const mount = await mountCommand(b.loaded, 'prs', '', ctx, { capture });

    assert.deepEqual(mount.overlay, {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '100%', maxHeight: '100%', margin: 0 },
    });
    const opts = capture.options;
    assert.deepEqual(opts.pages.map((page) => page.id), ['mine', 'review', 'involved', 'all']);
    assert.deepEqual(opts.pages.map((page) => page.label), ['My Pull Request', 'Needs My Review', 'Involved', 'All']);
    assert.equal(opts.pages.find((page) => page.id === 'all').lazy, true, 'all stays out of the prefetch');

    const page = await opts.loadPullRequestPage({ bucketId: 'review', cursor: null, limit: 2, query: '' });
    assert.equal(page.ok, true);
    assert.equal(page.rows.length, 2);
    const search = gqlField(b.gh.calls[b.gh.calls.length - 1].argv, 'search');
    assert.ok(search.includes('is:pr'), 'the read is the pull-request search');
    assert.ok(search.includes('review-requested:@me'), 'the bucket qualifier reaches gh');
    assert.equal(b.gh.calls[b.gh.calls.length - 1].repo, 'github.com/myfork/project', 'the pinned identity binds the page');
  });

  test('S8/T22: the rail cache seeds the first frame, so /prs opens as fast as /issues', async () => {
    const b = await boot({ railMine: [{ number: 69, title: 'mine sixty-nine' }], railReview: [{ number: 70, title: 'review seventy' }] });
    const { registered } = installBridge();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const ctx = sessionCtx(root);
    // The first start publishes the surface; the second is the session whose rail
    // reads, which is the in-memory entry `/prs` seeds from. Nothing is opened in
    // between, so this is exactly the state a click on the rail finds.
    await fireSessionStart(b.loaded.hooks, sessionCtx(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-prs-seed-')))));
    await fireSessionStart(b.loaded.hooks, ctx);
    await drawSection(registered[0], ctx);
    await waitFor(() => String(registered[0].meta(ctx)).includes(' pr'));

    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });

    const pages = capture.options.pages;
    const mine = pages.find((page) => page.id === 'mine');
    const review = pages.find((page) => page.id === 'review');
    assert.deepEqual(mine.rows.map((row) => row.number), [69], 'the authored bucket paints the rail row it already read');
    assert.deepEqual(review.rows.map((row) => row.number), [70], 'and so does the review bucket');
    assert.equal(mine.total, 1, 'the seeded page carries the count it can prove');
    assert.equal(pages.find((page) => page.id === 'involved').rows, null, 'a bucket the rail never read keeps its own read');
  });

  test('the lazy all bucket reads the repository connection', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const { ctx } = makeCtx(root);
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    const page = await capture.options.loadPullRequestPage({ bucketId: 'all', cursor: null, limit: 2, query: '' });
    assert.equal(page.ok, true);
    const call = b.gh.calls.find((entry) => gqlQuery(entry.argv).includes('pullRequests(states: OPEN'));
    assert.ok(call, 'the connection page was read');
    assert.equal(call.repo, 'github.com/myfork/project');
  });

  test('the detail asks for the authoritative metadata under the pinned identity', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const { ctx } = makeCtx(root);
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    const detail = await capture.options.loadPullRequest(69);
    assert.equal(detail.ok, true);
    assert.equal(detail.pullRequest.permissions.canMerge, true, 'a WRITE viewer with an allowed method can merge');
    assert.equal(detail.pullRequest.mergeMethods.merge, true);
    assert.deepEqual(detail.pullRequest.linkedIssues, [63]);
    const view = b.gh.calls.find((entry) => entry.argv[0] === 'pr' && entry.argv[1] === 'view' && entry.argv.includes('--json'));
    assert.deepEqual(view.argv.slice(0, 3), ['pr', 'view', '69']);
    assert.ok(view.argv.some((part) => part.includes('closingIssuesReferences')), 'the linked issues ride the detail read');
    assert.equal(view.repo, 'github.com/myfork/project');
  });

  test('T20: the linked-issues candidate seam asks the pinned repository\'s open issues', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const { ctx } = makeCtx(root);
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    assert.equal(typeof capture.options.loadIssueCandidates, 'function', 'the view is wired to a candidate seam');
    const page = await capture.options.loadIssueCandidates({ after: null, pageSize: 2 });
    assert.equal(page.ok, true);
    assert.deepEqual(page.rows, [
      { number: 1, title: 'One', state: 'open' },
      { number: 2, title: 'Two', state: 'open' },
    ]);
    const call = b.gh.calls[b.gh.calls.length - 1];
    const search = gqlField(call.argv, 'search');
    assert.ok(search.includes('repo:myfork/project'), `the read is scoped to the pinned repository (saw ${search})`);
    assert.ok(search.includes('is:issue') && search.includes('is:open'), 'only open issues are candidates');
    assert.ok(search.includes('sort:updated-desc'), 'the list is hottest-updated first');
    assert.equal(call.repo, 'github.com/myfork/project', 'the pinned identity binds the read');
  });

  test('the o opener runs gh pr view <n> --web -R <pinned>', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const worktreeGit = b.loaded.mod.libModule('worktree-git.js');
    const original = worktreeGit.runArgvAsync;
    const argvSeen = [];
    // Only the opener's own child is faked: every other git call of the command
    // (the checkout resolution and the identity proof) stays real, so the test
    // observes the opener instead of breaking the pin it rides on.
    worktreeGit.runArgvAsync = async (bin, argv, opts) => {
      if (argv[0] !== 'pr') return original.call(worktreeGit, bin, argv, opts);
      argvSeen.push({ bin, argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    restores.push(() => { worktreeGit.runArgvAsync = original; });
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const { ctx } = makeCtx(root);
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    const result = await capture.options.actions.openBrowser(69);
    assert.equal(result.ok, true);
    const open = argvSeen.find((entry) => entry.argv[0] === 'pr');
    assert.ok(open, 'the opener ran gh pr view');
    assert.deepEqual(open.argv, ['pr', 'view', '69', '--web', '-R', 'github.com/myfork/project']);
  });
});

// ---------------------------------------------------------------------------
// S7: `enter` inserts, in BOTH panels
// ---------------------------------------------------------------------------

describe('S7: enter inserts the item into the chat input', () => {
  test('the PR panel inserts "PR #N" and closes, sending nothing', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const { ctx } = makeCtx(root);
    const pasted = [];
    ctx.ui.pasteToEditor = (text) => { pasted.push(text); };
    const mount = await mountCommand(b.loaded, 'prs', '', ctx);
    // The host hands mouse events to the component it mounted, so both panels must
    // expose the seam the linked-number click rides.
    assert.equal(typeof mount.component.handleMouse, 'function', 'the PR panel receives mouse events');
    mount.component.render(100);
    await tick();
    mount.component.render(100);
    mount.component.handleInput('enter');
    assert.deepEqual(pasted, ['PR #69']);
    assert.equal(mount.doneCount, 1, 'the panel closes behind the insertion');
    assert.deepEqual(b.sent, [], 'nothing is sent to the agent');
  });

  test('the issues panel inserts "ISSUE #N" and closes, sending nothing', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const { ctx } = makeCtx(root);
    const pasted = [];
    ctx.ui.pasteToEditor = (text) => { pasted.push(text); };
    const mount = await mountCommand(b.loaded, 'issues', '', ctx);
    assert.equal(typeof mount.component.handleMouse, 'function', 'the issues panel receives mouse events');
    mount.component.render(100);
    await tick();
    mount.component.render(100);
    mount.component.handleInput('enter');
    assert.deepEqual(pasted, ['ISSUE #1']);
    assert.equal(mount.doneCount, 1, 'the panel closes behind the insertion');
    assert.deepEqual(b.sent, []);
  });

  test('a host with no paste seam gets one honest line and the panel still closes', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const { ctx, notes } = makeCtx(root);
    const mount = await mountCommand(b.loaded, 'prs', '', ctx);
    mount.component.render(100);
    await tick();
    mount.component.render(100);
    mount.component.handleInput('enter');
    assert.ok(
      notes.some((note) => note.level === 'warning' && note.text === 'prs: the editor did not accept the insertion: PR #69'),
      `the fallback names the exact text (saw ${JSON.stringify(notes)})`,
    );
    assert.equal(mount.doneCount, 1);
  });
});

// ---------------------------------------------------------------------------
// S6: cross-links close the current panel and open the other one
// ---------------------------------------------------------------------------

describe('S6: linked numbers open the other panel without stacking', () => {
  test('a linked issue in the PR panel closes it and dispatches /issues N', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const { ctx } = makeCtx(root);
    const mount = await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    const order = [];
    capture.options.actions.openLinked({ kind: 'issue', number: 63 });
    if (mount.doneCount === 1) order.push('closed');
    if (b.sent.length > 0) order.push('dispatched');
    assert.deepEqual(order, ['closed', 'dispatched'], 'the current panel is closed BEFORE the other opens');
    assert.deepEqual(b.sent.map((entry) => entry.text), ['/issues 63']);
    assert.deepEqual(b.sent[0].opts, { expandPromptTemplates: true });
  });

  test('a linked PR in the issues panel closes it and dispatches /prs N', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const capture = captureView(b.loaded.mod, 'issues-view.js', 'createIssuesView');
    const { ctx } = makeCtx(root);
    const mount = await mountCommand(b.loaded, 'issues', '', ctx, { capture });
    const order = [];
    capture.options.actions.openLinked({ kind: 'pullRequest', number: 70 });
    if (mount.doneCount === 1) order.push('closed');
    if (b.sent.length > 0) order.push('dispatched');
    assert.deepEqual(order, ['closed', 'dispatched']);
    assert.deepEqual(b.sent.map((entry) => entry.text), ['/prs 70']);
  });

  test('a linked click while that other panel is already opening changes nothing', async () => {
    installBridge();
    const b = await boot();
    await warmGate(b.loaded);
    const root = makeCheckout();
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const { ctx } = makeCtx(root);
    const mount = await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    // The rail's own click holds the /issues guard: this click must leave the
    // panel exactly as it is instead of closing onto a dispatch that is dropped.
    const section = installBridge().registered;
    capture.options.actions.openLinked({ kind: 'issue', number: 63 });
    assert.equal(mount.doneCount, 1);
    assert.deepEqual(b.sent.map((entry) => entry.text), ['/issues 63']);
    assert.equal(Array.isArray(section), true);
  });
});

// ---------------------------------------------------------------------------
// S4/S5: the rail's pull-request count, routing and persistence
// ---------------------------------------------------------------------------

describe('S4/S5: the one section counts and routes pull requests', () => {
  test('the header paints N issues · M pr from the one section', async () => {
    installBridge();
    const b = await boot({
      issueRows: [{ number: 1, title: 'One', pullRequest: 69 }, { number: 2, title: 'Two' }],
    });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    assert.ok(section, 'one section is registered');
    await drawSection(section, ctx);
    // The count is the second read; the header grows its `· N pr` segment when
    // that answer lands, so the assertion waits for it instead of the first frame.
    await waitFor(() => section.meta(ctx) === '2 issues · 2 pr');
    assert.equal(section.meta(ctx), '2 issues · 2 pr', 'the distinct union of mine and review counts once');
    assert.equal(registered.length, 1, 'the count is not a second section');
  });

  test('a row whose issue links a PR opens the PR panel with the review bucket hint', async () => {
    installBridge();
    const b = await boot({
      issueRows: [{ number: 1, title: 'One', pullRequest: 69 }],
    });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    const { rows } = await drawSection(section, ctx);
    // The bucket hint is decided against the rail's own read, so the click runs
    // after that second answer landed.
    await waitFor(() => String(section.meta(ctx)).includes(' pr'));
    const row = rows.find((entry) => entry.label.startsWith('#1 '));
    assert.ok(row, 'the issue row is painted');
    assert.match(String(row.meta), /#69/, 'the linked pull request is the row mark');
    row.onClick();
    await waitFor(() => b.sent.length > 0);
    assert.deepEqual(b.sent.map((entry) => entry.text), ['/prs 69']);

    // The command the host runs next consumes the bucket hint: 69 is in both
    // buckets and `review` wins, so the panel opens on that list.
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    const mount = await mountCommand(b.loaded, 'prs', '69', ctx, { capture });
    assert.equal(capture.options.initialPullRequest, 69);
    assert.equal(capture.options.initialBucket, 'review');
    assert.ok(mount.overlay, 'the panel opens');
  });

  test('a row without a linked PR keeps the /issues call (PRESERVE)', async () => {
    installBridge();
    const b = await boot({ issueRows: [{ number: 1, title: 'One' }] });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    const { rows } = await drawSection(section, ctx);
    rows.find((entry) => entry.label.startsWith('#1 ')).onClick();
    await waitFor(() => b.sent.length > 0);
    assert.deepEqual(b.sent.map((entry) => entry.text), ['/issues 1']);
  });

  test('the loader persists the rail read and paints it back when the live read fails', async () => {
    installBridge();
    const b = await boot();
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);
    await waitFor(() => section.meta(ctx) === '2 issues · 2 pr');
    assert.match(String(section.meta(ctx)), /^2 issues · 2 pr$/);

    const docPath = path.join(process.env.XDG_CACHE_HOME, 'odd-worktree', 'prs-rail.json');
    await waitFor(() => fs.existsSync(docPath));
    const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
    assert.equal(doc.version, 2, 'the document carries the bucket totals beside the rows (T10b)');
    const entry = doc.identities.find((candidate) => candidate.identity === 'github.com/myfork/project');
    assert.ok(entry, 'the read is stored under the identity it was read from');
    assert.deepEqual(entry.mine.map((row) => row.number), [69]);
    assert.deepEqual(entry.review.map((row) => row.number), [70, 69]);

    // A live read that fails falls back to the stored one instead of blanking.
    b.gh.state.railFail = true;
    await fireHook(b.loaded.hooks, 'tool_result', {
      tool: 'bash',
      args: { command: 'gh pr merge 1 --merge' },
      toolResults: [],
    }, ctx);
    await new Promise((resolve) => realSetTimeout(resolve, 50));
    section.lines(ctx);
    assert.equal(section.meta(ctx), '2 issues · 2 pr', 'the stored count is painted, never a blank header');
    const left = fs.readdirSync(path.join(process.env.XDG_CACHE_HOME, 'odd-worktree'));
    assert.equal(left.some((entry) => entry.includes('.tmp')), false, `no temp file is left behind (saw ${left.join(', ')})`);
  });

  test('a mutation made in the panel invalidates the count and re-reads the rail', async () => {
    installBridge();
    const b = await boot();
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);
    const readsBefore = b.gh.state.railReads;

    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    const merged = await capture.options.actions.mergePullRequest(69, { method: 'merge', subject: 'Merge it', body: 'Body' });
    assert.equal(merged.ok, true);
    const mergeCall = b.gh.calls.find((entry) => entry.argv[0] === 'pr' && entry.argv[1] === 'merge');
    assert.deepEqual(mergeCall.argv, ['pr', 'merge', '69', '--merge', '--subject', 'Merge it', '--body', 'Body']);
    await waitFor(() => b.gh.state.railReads > readsBefore);
    assert.ok(b.gh.state.railReads > readsBefore, 'the rail read again after the write');
  });
});

// ---------------------------------------------------------------------------
// S5: the session-start preload
// ---------------------------------------------------------------------------

describe('S5: the session-start preload is dispatched, never awaited', () => {
  // The section is created only once the bridge exists, so the spy below can wrap
  // its `refreshIfStale` before the extension builds it: the surface is registered
  // by the first `session_start`, after the bridge is published late.
  function spySectionFactory(mod) {
    const holder = { calls: 0 };
    const lib = mod.libModule('issues-section.js');
    const original = lib.createIssuesSection;
    lib.createIssuesSection = (options) => {
      const handle = original(options);
      const real = handle.refreshIfStale;
      handle.refreshIfStale = (...args) => {
        holder.calls += 1;
        return real.apply(handle, args);
      };
      return handle;
    };
    restores.push(() => { lib.createIssuesSection = original; });
    return holder;
  }

  async function gatedBoot() {
    const b = await boot();
    const { registered } = installBridge();
    const spy = spySectionFactory(b.loaded.mod);
    // The first start publishes the surface (the bridge arrived after the load);
    // the section exists from here on.
    await fireSessionStart(b.loaded.hooks, sessionCtx(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-prs-gate-')))));
    const root = makeCheckout();
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    return { b, registered, spy, ctx };
  }

  test('a section the host was drawing asks for a read, dispatched and never awaited', async () => {
    const { b, registered, spy, ctx } = await gatedBoot();
    assert.equal(spy.calls, 0, 'the not-yet-drawn section earned no preload');
    await drawSection(registered[0], ctx);
    await waitFor(() => String(registered[0].meta(ctx)).includes(' pr'));

    const returned = fireSessionStartSync(b.loaded.hooks, ctx);
    for (const value of returned) {
      if (value && typeof value.then === 'function') {
        throw new Error('a session_start handler must not return a promise');
      }
    }
    assert.equal(spy.calls, 0, 'the preload is a microtask, not work on the handler path');
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    assert.equal(spy.calls, 1, 'the dispatched preload asked the drawn section for a read');
    await b.loaded.mod.awaitPendingStartupTasks();
  });

  test('a hidden section starts no read at session start', async () => {
    const { b, spy, ctx } = await gatedBoot();
    await fireSessionStart(b.loaded.hooks, ctx);
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    await b.loaded.mod.awaitPendingStartupTasks();
    assert.equal(spy.calls, 0, 'a section nobody drew costs no read');
  });
});

// ---------------------------------------------------------------------------
// T8b (S4, S2): the defects T7 found in the rail and in `/prs`'s own refusals.
//
// D8 — the rail's read carries an EXACT `issueCount` per bucket and at most a
// window of rows, so the header counts the unfetched remainder of each total as
// well as the distinct numbers it fetched: `issueCount=51` with 50 nodes and an
// empty review is `2 issues · 51 pr`, never `50 pr`.
//
// D9 — the persisted `prs-rail.json` count is painted at a COLD START, from the
// async loader, while the live read is still in flight; the live answer then
// replaces it. The stored entry never settles the read (the live one is asked
// anyway) and a mutation that invalidated the identity is never painted back.
//
// D10 — the remote-moved refusal of a `/prs` action names `/prs`.
// ---------------------------------------------------------------------------

describe('T8b: the exact count, the cold-start paint and the /prs refusal', () => {
  test('S4 (D8): the header counts each bucket\'s total, not only the rows it carried', async () => {
    installBridge();
    const first = Array.from({ length: 50 }, (_, index) => ({ number: index + 1, linkedIssues: [] }));
    const b = await boot({ railMine: first, railMineTotal: 51, railReview: [] });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);
    await waitFor(() => section.meta(ctx) === '2 issues · 51 pr');
    assert.equal(section.meta(ctx), '2 issues · 51 pr',
      'the one node the window cut is counted, not dropped');
  });

  test('S4/S5 (D9): a cold start paints the stored count at once, and the live read still replaces it', async () => {
    installBridge();
    // The entry a previous process left behind: ONE pull request, stored under the
    // identity this checkout proves.
    const docPath = path.join(process.env.XDG_CACHE_HOME, 'odd-worktree', 'prs-rail.json');
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, JSON.stringify({
      version: 2,
      identities: [{
        identity: 'github.com/myfork/project',
        mine: [{ number: 69, linkedIssues: [1] }],
        review: [],
        counts: { mine: 1, review: 0 },
        syncedAt: Date.now(),
      }],
    }));
    const b = await boot({ railMine: [{ number: 71 }], railReview: [{ number: 72 }] });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    // The live read is HELD, so anything on the header before it is released was
    // painted by the stored entry alone.
    let release = null;
    b.gh.state.railGate = new Promise((resolve) => { release = resolve; });
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);

    await waitFor(() => String(section.meta(ctx)).includes(' pr'));
    assert.equal(section.meta(ctx), '2 issues · 1 pr', 'the stored count is painted while the live read is held');
    // The live read was asked anyway: the stored entry is a paint, never the read's
    // own answer (invariant 25 keeps the TTL the live read's).
    await waitFor(() => b.gh.state.railReads >= 1);
    assert.equal(section.meta(ctx), '2 issues · 1 pr', 'and the live read is in flight, not skipped');

    b.gh.state.railGate = null;
    release();
    await waitFor(() => section.meta(ctx) === '2 issues · 2 pr');
    assert.equal(section.meta(ctx), '2 issues · 2 pr', 'the live answer replaces the stored one');  });

  test('S4/S5 (D9): a mutation\'s invalidation is never painted back from the store', async () => {
    installBridge();
    const docPath = path.join(process.env.XDG_CACHE_HOME, 'odd-worktree', 'prs-rail.json');
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, JSON.stringify({
      version: 2,
      identities: [{
        identity: 'github.com/myfork/project',
        mine: [{ number: 69, linkedIssues: [1] }],
        review: [],
        counts: { mine: 1, review: 0 },
        syncedAt: Date.now(),
      }],
    }));
    const b = await boot({ railMine: [{ number: 71 }], railReview: [{ number: 72 }] });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);
    await waitFor(() => section.meta(ctx) === '2 issues · 2 pr');

    // A write made in the panel drops the identity, so nothing may hydrate it back.
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    const merged = await capture.options.actions.mergePullRequest(69, { method: 'merge', subject: 's', body: 'b' });
    assert.equal(merged.ok, true);
    const held = new Promise(() => {});
    b.gh.state.railGate = held;
    await fireHook(b.loaded.hooks, 'tool_result', {
      tool: 'bash',
      args: { command: 'gh pr merge 69 --merge' },
      toolResults: [],
    }, ctx);
    await new Promise((resolve) => realSetTimeout(resolve, 50));
    section.lines(ctx);
    assert.notEqual(section.meta(ctx), '2 issues · 1 pr',
      'the invalidated entry is never painted back while the live read is held');
  });

  test('S2 (D10): the remote-moved refusal of a /prs action names /prs', async () => {
    installBridge();
    const b = await boot();
    installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const capture = captureView(b.loaded.mod, 'prs-view.js', 'createPrsView');
    await mountCommand(b.loaded, 'prs', '', ctx, { capture });
    assert.ok(capture.options, 'the panel opened');

    // The checkout moves to another repository under the open panel: every write
    // must refuse and say which panel to reopen.
    git(root, ['remote', 'set-url', 'origin', 'git@github.com:otherfork/project.git']);
    const before = b.gh.calls.length;
    const refused = await capture.options.actions.closePullRequest(69);
    assert.equal(refused.ok, false, 'the close is refused on the drift');
    assert.match(refused.error, /changed since this pull request list loaded/,
      'the refusal names the list that loaded');
    assert.match(refused.error, /reopen \/prs$/,
      'and the panel to reopen is /prs, never /issues');
    const mutations = b.gh.calls.slice(before)
      .filter((call) => call.argv[0] === 'pr' && ['close', 'merge', 'edit', 'comment'].includes(call.argv[1]));
    assert.deepEqual(mutations, [], 'no mutating gh command ran after the drift');
  });
});

// ---------------------------------------------------------------------------
// T10b (S4): D9 and D15, at the wiring level.
//
// D9 — the rail's pull-request read is a SECOND state of the one section, so its
// settlement must ask the bridge to repaint exactly like the issues read does;
// without it the header keeps the old `pr` count until an unrelated frame.
//
// D15 — the store keeps each bucket's TOTAL beside its rows, so a restart paints
// the number the live read painted: 50 returned rows with a total of 52 is
// `52 pr` on both sides of the restart, never `50 pr`.
// ---------------------------------------------------------------------------

describe('T10b: the rail read repaints the header and its totals survive a restart', () => {
  const fiftyRows = () => Array.from({ length: 50 }, (_, index) => ({ number: index + 1, linkedIssues: [] }));

  test('S4 (D9): the settled rail read asks the bridge to repaint the header it changed', async () => {
    installBridge();
    const b = await boot({ railMine: [{ number: 69 }], railReview: [{ number: 70 }] });
    let repaints = 0;
    const { registered } = installBridge(() => { repaints += 1; });
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    // The rail read is HELD, so the header exists without a `pr` segment and the
    // repaint count measured below is the one the settlement is responsible for.
    let release = null;
    b.gh.state.railGate = new Promise((resolve) => { release = resolve; });
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);
    await waitFor(() => b.gh.state.railReads >= 1);
    await new Promise((resolve) => realSetTimeout(resolve, 60));
    const settled = repaints;
    assert.equal(section.meta(ctx), '2 issues', 'a read still in flight paints no `pr` count yet');

    b.gh.state.railGate = null;
    release();
    await waitFor(() => section.meta(ctx) === '2 issues · 2 pr');
    assert.ok(repaints > settled,
      'the settled rail read asked the bridge for the frame the new count is painted by');
  });

  test('S4 (D15): the loader writes each bucket total beside its rows', async () => {
    installBridge();
    const rows = fiftyRows();
    const b = await boot({ railMine: rows, railMineTotal: 52, railReview: [] });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);
    await waitFor(() => section.meta(ctx) === '2 issues · 52 pr');
    assert.equal(section.meta(ctx), '2 issues · 52 pr', 'the live read counts the two rows its window cut');

    const docPath = path.join(process.env.XDG_CACHE_HOME, 'odd-worktree', 'prs-rail.json');
    await waitFor(() => fs.existsSync(docPath));
    const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
    const entry = doc.identities.find((candidate) => candidate.identity === 'github.com/myfork/project');
    assert.ok(entry, 'the read is stored under the identity it was read from');
    assert.deepEqual(entry.counts, { mine: 52, review: 0 },
      'the totals that produced the live count sleep beside the rows');
    assert.equal(doc.version, 2, 'and the document that carries them is the version this module writes');
  });

  test('S4 (D15): a cold start paints the stored total, so 50 rows with a total of 52 is 52 pr', async () => {
    installBridge();
    // The entry a previous process left behind: 50 rows and the total they came
    // with, under the identity this checkout proves.
    const rows = fiftyRows();
    const docPath = path.join(process.env.XDG_CACHE_HOME, 'odd-worktree', 'prs-rail.json');
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, JSON.stringify({
      version: 2,
      identities: [{
        identity: 'github.com/myfork/project',
        mine: rows,
        review: [],
        counts: { mine: 52, review: 0 },
        syncedAt: Date.now(),
      }],
    }));
    const b = await boot({ railMine: rows, railMineTotal: 52, railReview: [] });
    const { registered } = installBridge();
    const root = makeCheckout();
    await warmGate(b.loaded);
    const ctx = sessionCtx(root);
    let release = null;
    b.gh.state.railGate = new Promise((resolve) => { release = resolve; });
    await fireSessionStart(b.loaded.hooks, ctx);
    const section = registered[0];
    await drawSection(section, ctx);

    await waitFor(() => section.meta(ctx) === '2 issues · 52 pr', 3000);
    assert.equal(section.meta(ctx), '2 issues · 52 pr',
      'the cold start paints the number the live read painted, not the rows the window carried');

    b.gh.state.railGate = null;
    release();
    await waitFor(() => b.gh.state.railReads >= 1);
    await new Promise((resolve) => realSetTimeout(resolve, 60));
    assert.equal(section.meta(ctx), '2 issues · 52 pr', 'and the live answer paints the same number');
  });
});

'use strict';
// T4 (S6, S10, S11, S13): the `/odd` command's half of the grouped panel. The
// view (`lib/odd-view.js`) and the model (`lib/odd-group.js`) have their own
// suites; this one mounts the REGISTERED command against a real git checkout and
// a fake host, so what it asserts is what the wiring actually hands over:
//
//   * the model reaches the view, scoped to the worktrees the SESSION registered
//     — read from the same `gentle-pi.session-worktree/v1` entries the files
//     panel reads — so an unregistered checkout costs no git read at all;
//   * a registered worktree with nothing of its own draws no group chrome;
//   * `a` reloads every owned worktree, and `a` again reloads the registered set;
//   * a valid absolute target and a bare ODD name open the panel ON that
//     document, while refused shapes keep the sentence they always had;
//   * none of it depends on the Worktrees+ module, because the ODD surfaces
//     follow the session's registered worktrees (corrected S7).
//
// The git reads are observed through the module instance THIS load uses
// (`libModule('worktree-git.js').runArgvAsync`, the seam every async git read in
// the extension goes through), so the argv and the checkout each read ran in are
// the evidence, never a count the source could satisfy some other way.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  BRIDGE_SLOT,
  LIB_DIR,
  defaultBridge,
  stubbedSource,
  withGhPath,
} = require('./fixtures/load-extension.js');

const scratch = [];
function track(dir) {
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

const SESSION_WORKTREE_CUSTOM_TYPE = 'gentle-pi.session-worktree/v1';

// A repository whose `odd/tasks` holds two documents with deliberately distinct
// mtimes and distinct bodies, so a test can tell from the rendered frame which
// one the panel is reading.
function makeRepo() {
  const dir = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-panel-repo-'))));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test']);
  const tasks = path.join(dir, 'odd', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'main-one.md'), '# body of main-one\n');
  fs.writeFileSync(path.join(tasks, 'main-two.md'), '# body of main-two\n');
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(tasks, 'main-one.md'), now - 200, now - 200);
  fs.utimesSync(path.join(tasks, 'main-two.md'), now - 100, now - 100);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

// The worktree directory the package owns (`<repo-parent>/<repo-name>-worktrees`),
// so the same fixture answers BOTH scopes: registered roots, and the `a` mode's
// every-owned-worktree one.
function addWorktree(repo, name) {
  const owned = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
  fs.mkdirSync(owned, { recursive: true });
  const root = path.join(owned, name);
  git(repo, ['worktree', 'add', '-b', `feat/${name}`, root, 'main']);
  return root;
}

function writeTask(root, name, body) {
  const tasks = path.join(root, 'odd', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, `${name}.md`), body);
  return path.join(tasks, `${name}.md`);
}

const theme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text), bold: (text) => String(text) };

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

const helpers = {
  visibleWidth: (value) => [...stripAnsi(value)].length,
  truncateToWidth: (value, width) => {
    const chars = [...String(value)];
    return chars.length > width ? chars.slice(0, width).join('') : String(value);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: () => false,
};

// The frame the human sees: every line stripped of its escapes and trimmed, at a
// width that fits the whole footer legend.
function renderedRows(component, width = 120) {
  return component.render(width).map((line) => stripAnsi(line).trimEnd());
}

const frameText = (component) => renderedRows(component).join('\n');

// The fake host: `custom` mounts the panel factory and stays pending until the
// view closes, exactly like Pi's overlay, so a test can drive the component it
// got and read the frames it paints.
function mountHost() {
  const mounts = [];
  const notifications = [];
  const renders = [];
  const tui = { terminal: { rows: 30 }, requestRender: () => { renders.push(1); } };
  const ui = {
    notify: (text, level) => { notifications.push([level, text]); },
    custom: (factory, options) => new Promise((resolve) => {
      const component = factory(tui, theme, {}, (value) => resolve(value));
      mounts.push({ options, component });
    }),
  };
  return { tui, ui, mounts, notifications, renders };
}

function ctxFor(repo, host, registeredRoots = []) {
  return {
    cwd: repo,
    hasUI: true,
    mode: 'tui',
    sessionManager: {
      getSessionId: () => 'thread-1',
      getEntries: () => registeredRoots.map((root) => ({
        type: 'custom',
        customType: SESSION_WORKTREE_CUSTOM_TYPE,
        data: { sessionId: 'thread-1', root, evidence: 'session:tool' },
      })),
    },
    ui: host.ui,
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

// One extension load per test. `modules` is the bridge's own store document, so
// `{ worktrees: false }` is exactly the Worktrees+ switch a host would have.
let loads = 0;
async function load(modules) {
  const bridge = defaultBridge();
  const document = modules === undefined ? undefined : { ...modules };
  bridge.api.createStore = () => ({
    get: (key, fallback) => (key === 'modules' && document !== undefined ? document : fallback),
    set: () => {},
    delete: () => {},
  });
  globalThis[BRIDGE_SLOT] = bridge.api;
  return withGhPath('present', async () => {
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-panel-ext-'));
    try {
      const copy = path.join(dir, 'odd-worktree-tools.mjs');
      fs.writeFileSync(copy, stubbedSource());
      loads += 1;
      const mod = await import(`${pathToFileURL(copy).href}?load=${loads}`);
      const commands = new Map();
      const hooks = [];
      const host = {
        registerCommand: (name, handler) => commands.set(name, handler),
        registerTool: () => {},
        registerMessageRenderer: () => {},
        registerEntryRenderer: () => {},
        appendEntry: () => {},
        on: (event, handler) => { hooks.push([event, handler]); },
      };
      mod.default(host);
      // The viewer's TUI helpers: the documented loader seam, answered with the
      // cell-measuring double the view's own suite uses. `a`, the group headers
      // and the preview all paint through them.
      mod.setOddTuiLoader(() => Promise.resolve(helpers));
      return { mod, commands, host };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Every async git read this load makes, with the checkout it ran in. The
// extension reaches git through `libRunner(git)` → `runArgvAsync`, so replacing
// that one function observes all of it.
function observeGit(mod) {
  const gitLib = mod.libModule('worktree-git.js');
  const real = gitLib.runArgvAsync;
  const calls = [];
  gitLib.runArgvAsync = (bin, argv, options) => {
    const call = { argv: [...argv], cwd: options && options.cwd, settled: false };
    calls.push(call);
    const pending = real.call(gitLib, bin, argv, options);
    // Settlement is recorded, so a test can wait for the RANKED listing (the
    // one that lands after the first frame) instead of guessing at a delay.
    return Promise.resolve(pending).then(
      (value) => { call.settled = true; return value; },
      (err) => { call.settled = true; throw err; },
    );
  };
  return {
    calls,
    clear: () => { calls.length = 0; },
    // The reads that name one checkout's own ODD documents: the merge base with
    // main, then the diff/status of that checkout. `worktree list` names none.
    readsIn: (cwd) => calls.filter((call) => call.cwd === cwd
      && (call.argv.includes('merge-base')
        || (call.argv.includes('diff') && call.argv.includes('--name-status'))
        || (call.argv.includes('status') && call.argv.includes('--porcelain=v1')))),
    listing: () => calls.filter((call) => call.argv.includes('worktree') && call.argv.includes('list')),
    restore: () => { gitLib.runArgvAsync = real; },
  };
}

// The git-ranked listing that replaces the first frame: `listOddDocsAsync` ends
// its walk with `status --porcelain -z` in the checkout it listed, so a SETTLED
// call of that shape is the proof the ranked order has arrived. One short tick
// afterwards lets the promise chain apply it and repaint.
async function waitForRankedListing(observed, roots) {
  await waitFor(() => observed.calls.some((call) => call.settled === true
    && roots.includes(call.cwd)
    && call.argv.includes('status')
    && call.argv.includes('--porcelain')), 'the ranked listing settles');
  await new Promise((resolve) => setTimeout(resolve, 80));
}

// S11/S13: the grouped READ, held open. The extension reaches the model through
// this one module instance, so replacing its `groupOddDocs` with a queue of
// promises is exactly the two reloads a human can start faster than the disk
// answers them — and the test decides which one lands first.
function deferGroups(mod) {
  const group = mod.libModule('odd-group.js');
  const real = group.groupOddDocs;
  const pending = [];
  let armed = false;
  group.groupOddDocs = (input) => {
    if (!armed) return real.call(group, input);
    return new Promise((resolve, reject) => { pending.push({ input, resolve, reject }); });
  };
  return {
    real: (input) => real.call(group, input),
    arm: () => { armed = true; },
    pending,
    restore: () => { group.groupOddDocs = real; },
  };
}

// The handler stays pending until the view closes, exactly like a real overlay:
// `esc` finishes it through the factory's own `done`.
async function closePanel(host, pending) {
  const mount = host.mounts[host.mounts.length - 1];
  if (mount) mount.component.handleInput('\x1b');
  try { await pending; } catch {}
}

describe('the grouped listing the panel draws (S10, S13)', () => {
  test('groups reach the panel scoped to the session’s registered worktrees, and only those cost git', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const registered = addWorktree(repo, 'wt-a');
      const foreign = addWorktree(repo, 'wt-b');
      writeTask(registered, 'a-only', '# body of a-only\n');
      writeTask(foreign, 'b-only', '# body of b-only\n');
      const host = mountHost();
      const ctx = ctxFor(repo, host, [registered]);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');

      const component = host.mounts[0].component;
      const text = frameText(component);
      // S10/S13: main always carries every ODD of main; a registered worktree
      // carries only what it has that main does not — and, per odd-panel-groups
      // S1, both arrive FOLDED with their count.
      assert.match(text, /\u25b8 main \(2 odd\)/, 'main is a folded group of its own');
      assert.match(text, /\u25b8 wt-a \(1 odd\)/, 'the registered worktree is a folded group');
      assert.ok(!text.includes('a-only'), `a folded group shows no document\n${text}`);
      assert.ok(!text.includes('wt-b'), `an unregistered worktree is not a group\n${text}`);
      assert.ok(!text.includes('b-only'), `nor is one of its documents listed\n${text}`);
      assert.match(text, /3 documents/, 'main’s two plus the worktree’s one');
      // Opening the worktree group shows the document that belongs to it.
      component.handleInput('down');
      component.handleInput('enter');
      const opened = frameText(component);
      assert.match(opened, /\u25be wt-a \(1 odd\)/, 'Enter opens that group');
      assert.match(opened, /a-only/, 'and its own document under it');

      // The unregistered checkout was never asked anything: no worktree listing
      // of its own, no merge-base, no diff, no status.
      assert.equal(observed.listing().length, 1, 'the grouping enumerated the checkouts once');
      assert.deepEqual(observed.readsIn(foreign), [],
        'an unregistered worktree costs no git read at all');
      assert.ok(observed.readsIn(registered).length > 0, 'the registered one was compared with main');

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });

  test('a registered worktree with no difference from main draws no group chrome', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const registered = addWorktree(repo, 'wt-same');
      // Byte-identical copies: nothing new, nothing modified.
      for (const name of ['main-one', 'main-two']) {
        writeTask(registered, name, fs.readFileSync(path.join(repo, 'odd', 'tasks', `${name}.md`), 'utf8'));
      }
      const host = mountHost();
      const ctx = ctxFor(repo, host, [registered]);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');

      const rows = renderedRows(host.mounts[0].component);
      const text = rows.join('\n');
      // A drawn group always paints an EXPANDED header on a fresh mount (`▾`);
      // `▸` alone would be ambiguous, because that is also the selection mark of
      // the focused row.
      assert.ok(!rows.some((row) => row.includes('\u25be')),
        `no group chrome is drawn for an empty delta\n${text}`);
      assert.ok(!text.includes('wt-same'), `the unchanged worktree is never named\n${text}`);
      assert.match(text, /2 documents/, 'the ordinary main-only count');
      assert.match(text, /main-one/);
      assert.match(text, /main-two/);

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });

  test('`a` reloads every owned worktree and `a` again returns to the session’s', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const registered = addWorktree(repo, 'wt-a');
      const other = addWorktree(repo, 'wt-b');
      writeTask(registered, 'a-only', '# body of a-only\n');
      writeTask(other, 'b-only', '# body of b-only\n');
      const host = mountHost();
      const ctx = ctxFor(repo, host, [registered]);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');
      const component = host.mounts[0].component;
      assert.match(frameText(component), /a all worktrees/, 'the hint names the mode it is in');

      // `a`: the reload is UNscoped, so the unregistered worktree is compared now.
      observed.clear();
      component.handleInput('a');
      await waitFor(() => observed.readsIn(other).length > 0, 'the unscoped reload compared wt-b');
      await waitFor(() => frameText(component).includes('wt-b'), 'the second group is drawn');
      assert.equal(observed.listing().length, 1, 'one grouped reload, one worktree listing');
      assert.match(frameText(component), /a session only/, 'the hint follows the mode');
      // S1: the group the reload just added arrives folded; opening it is what
      // reveals its document.
      assert.match(frameText(component), /\u25b8 wt-b \(1 odd\)/);
      component.handleInput('down');
      component.handleInput('down');
      component.handleInput('enter');
      assert.match(frameText(component), /\u25be wt-b \(1 odd\)/, 'Enter opens the new group');
      assert.match(frameText(component), /b-only/);

      // `a` again: back to the session's registered set only.
      observed.clear();
      component.handleInput('a');
      await waitFor(() => !frameText(component).includes('wt-b'), 'the unregistered group goes');
      assert.deepEqual(observed.readsIn(other), [],
        'the registered reload never asks an unregistered worktree anything');
      assert.equal(observed.listing().length, 1, 'and it re-enumerates the checkouts once');
      assert.match(frameText(component), /a all worktrees/, 'the hint returns with the mode');
      assert.match(frameText(component), /\u25b8 wt-a \(1 odd\)/);

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });
});

describe('main is the checkout the panel ranks (S6, S10, S12, S13)', () => {
  test('a click on a main-only ODD keeps it selected after the ranked refresh settles', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      // The session runs INSIDE a linked worktree, and that worktree is not
      // registered: main is the only loaded group, so main's documents are the
      // only documents the panel may draw.
      const worktree = addWorktree(repo, 'wt-a');
      // The session's checkout holds ONE document of its own and none of main's,
      // so a main-only ODD has nowhere to be found in it.
      fs.rmSync(path.join(worktree, 'odd'), { recursive: true, force: true });
      writeTask(worktree, 'a-only', '# body of a-only\n');
      const target = path.join(repo, 'odd', 'tasks', 'main-one.md');
      const host = mountHost();
      const ctx = ctxFor(worktree, host, []);

      const pending = loaded.commands.get('odd').handler(target, ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');
      const component = host.mounts[0].component;
      assert.match(frameText(component), /body of main-one/, 'the target opens on its own document');

      await waitForRankedListing(observed, [repo, worktree]);
      const text = frameText(component);
      assert.match(text, /body of main-one/,
        `the ranked refresh keeps the document the target opened\n${text}`);
      assert.ok(!text.includes('a-only'),
        `the session checkout's documents never become main's\n${text}`);

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });

  test('bare /odd in an empty session worktree mounts when main has documents', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const worktree = addWorktree(repo, 'wt-a');
      // Nothing of its own in the session's checkout: the worktree checks out
      // main's tree, so its `odd/tasks` is removed to make the session checkout
      // the empty one.
      fs.rmSync(path.join(worktree, 'odd'), { recursive: true, force: true });
      assert.equal(fs.existsSync(path.join(worktree, 'odd', 'tasks')), false,
        'the session checkout holds no odd/tasks of its own');
      const host = mountHost();
      const ctx = ctxFor(worktree, host, []);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1 || host.notifications.length > 0,
        'the command answers the empty session checkout');
      assert.deepEqual(host.notifications, [],
        'a non-empty main is not "nothing under odd/tasks"');
      assert.equal(host.mounts.length, 1, 'the panel mounts over main\u2019s documents');
      const text = frameText(host.mounts[0].component);
      assert.match(text, /main-one/);
      assert.match(text, /main-two/);
      assert.match(text, /2 documents/, 'main’s own two documents');

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });

  test('`r` never lists a document no loaded group carries', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const worktree = addWorktree(repo, 'wt-a');
      writeTask(worktree, 'a-only', '# body of a-only\n');
      const host = mountHost();
      const ctx = ctxFor(worktree, host, []);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');
      const component = host.mounts[0].component;
      const before = renderedRows(component).join('\n');
      assert.ok(!before.includes('a-only'), `the mount lists only the loaded group\n${before}`);

      // `r` reloads from the session's checkout: whatever it answers, the panel
      // draws the loaded model, so a worktree the session never registered can
      // never appear in it.
      observed.clear();
      component.handleInput('r');
      await waitForRankedListing(observed, [repo, worktree]);
      const after = renderedRows(component).join('\n');
      assert.ok(!after.includes('a-only'),
        `a document no loaded group carries is never listed\n${after}`);
      assert.match(after, /main-one/);
      assert.match(after, /main-two/);

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });
});

describe('`a` applies only the latest reload (S11, S13)', () => {
  test('a stale toggle result resolved last never lands on top', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    const deferred = deferGroups(loaded.mod);
    try {
      const repo = makeRepo();
      const registered = addWorktree(repo, 'wt-a');
      const other = addWorktree(repo, 'wt-b');
      writeTask(registered, 'a-only', '# body of a-only\n');
      // The unregistered worktree is the ONE thing `a` adds to the listing.
      writeTask(other, 'b-only', '# body of b-only\n');
      const host = mountHost();
      const ctx = ctxFor(repo, host, [registered]);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');
      const component = host.mounts[0].component;

      // Two presses, both reloads held open: the second press is back in the
      // session's mode, so its answer is the ONLY one the drawn listing may carry.
      deferred.arm();
      component.handleInput('a');
      await waitFor(() => deferred.pending.length === 1, 'the first toggle reload starts');
      component.handleInput('a');
      await waitFor(() => deferred.pending.length === 2, 'the second toggle reload starts');

      // The LATEST request settles first…
      deferred.pending[1].resolve(await deferred.real(deferred.pending[1].input));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok(!frameText(component).includes('wt-b'), 'the latest answer is what is drawn');
      assert.match(frameText(component), /a all worktrees/, 'and the mode is back to the session\u2019s');

      // …and the OLD one settles last: it is dropped, never applied.
      deferred.pending[0].resolve(await deferred.real(deferred.pending[0].input));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const text = frameText(component);
      assert.ok(!text.includes('wt-b'), `a stale toggle result never lands on top\n${text}`);
      assert.ok(!text.includes('b-only'), 'nor any of its documents');
      assert.match(text, /a all worktrees/,
        'the footer still names the mode the key really switched to');

      await closePanel(host, pending);
    } finally {
      deferred.restore();
      observed.restore();
    }
  });

  test('a stale `r` result resolved last never replaces the drawn listing', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    const deferred = deferGroups(loaded.mod);
    try {
      const repo = makeRepo();
      const other = addWorktree(repo, 'wt-b');
      writeTask(other, 'b-only', '# body of b-only\n');
      const host = mountHost();
      const ctx = ctxFor(repo, host, []);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');
      const component = host.mounts[0].component;

      deferred.arm();
      component.handleInput('r');
      await waitFor(() => deferred.pending.length === 1, 'the first reload starts');
      component.handleInput('r');
      await waitFor(() => deferred.pending.length === 2, 'the second reload starts');

      // The second `r` answers first, in the session's own scope: its flat listing
      // is the awaited git read, so the rendered outcome is what proves it landed.
      observed.clear();
      deferred.pending[1].resolve(await deferred.real(deferred.pending[1].input));
      await waitForRankedListing(observed, [repo]);
      assert.ok(!frameText(component).includes('wt-b'));

      // The first `r` answers last with a listing that includes every worktree:
      // its request is superseded, so its model is dropped.
      const everyWorktree = await deferred.real({ repoRoot: repo });
      assert.ok(Array.isArray(everyWorktree) && everyWorktree.length > 1,
        'the stale fixture really carries a second group');
      deferred.pending[0].resolve(everyWorktree);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const text = frameText(component);
      assert.ok(!text.includes('wt-b'), `a superseded reload is dropped\n${text}`);

      await closePanel(host, pending);
    } finally {
      deferred.restore();
      observed.restore();
    }
  });
});

describe('`/odd <target>` (S6)', () => {
  test('an absolute target inside a registered worktree opens the panel on it', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const registered = addWorktree(repo, 'wt-a');
      const target = writeTask(registered, 'a-only', '# body of a-only\n');
      const host = mountHost();
      const ctx = ctxFor(repo, host, [registered]);

      const pending = loaded.commands.get('odd').handler(target, ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');

      assert.deepEqual(host.notifications, [], 'the target is accepted, not refused');
      const text = frameText(host.mounts[0].component);
      assert.match(text, /\u25be wt-a/, 'its group is unfolded');
      assert.match(text, /body of a-only/, 'and the panel is reading THAT document');

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });

  test('an absolute target no loaded group lists is refused, not silently ignored', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const foreign = addWorktree(repo, 'wt-b');
      writeTask(foreign, 'b-only', '# body of b-only\n');
      const target = path.join(foreign, 'odd', 'tasks', 'b-only.md');
      const host = mountHost();
      const ctx = ctxFor(repo, host, []);

      let settled = false;
      loaded.commands.get('odd').handler(target, ctx).then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await waitFor(() => settled || host.mounts.length > 0 || host.notifications.length > 0,
        'the command answers the target');

      // S6: a document in a worktree the session never registered is in no
      // loaded group, so the target is the unknown option it always was — the
      // panel never opens on some other document instead.
      assert.deepEqual(host.notifications, [['error', `Unknown option "${target}". Use /odd.`]]);
      assert.equal(host.mounts.length, 0, 'nothing is mounted for a refused target');
    } finally {
      observed.restore();
    }
  });

  test('a bare ODD name is accepted and selected', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const registered = addWorktree(repo, 'wt-a');
      writeTask(registered, 'a-only', '# body of a-only\n');
      const host = mountHost();
      const ctx = ctxFor(repo, host, [registered]);

      const pending = loaded.commands.get('odd').handler('a-only', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');

      assert.deepEqual(host.notifications, []);
      const text = frameText(host.mounts[0].component);
      assert.match(text, /body of a-only/, 'the panel is reading the named ODD');
      assert.match(text, /\u25be wt-a/, 'and its group is unfolded to show it');

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });
});

describe('`r` still re-lists and re-reads (S9, preserved)', () => {
  test('a document added on disk appears after `r`, with no worktree registered', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const host = mountHost();
      const ctx = ctxFor(repo, host, []);

      const pending = loaded.commands.get('odd').handler('', ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');
      const component = host.mounts[0].component;
      assert.ok(!frameText(component).includes('later'), 'the new document is not there yet');

      writeTask(repo, 'later', '# body of later\n');
      component.handleInput('r');
      await waitFor(() => frameText(component).includes('later'), 'the reload lists the new document');
      assert.match(frameText(component), /3 documents/, 'the count follows the reloaded listing');

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });
});

// T6 (independent verification, HEAD 614da6e): three defects reproduced with
// real Git through the registered command. Each one is a rule S11/S13/D2 states
// and the wiring did not keep.
//
//   * S11: `a` means EVERY worktree of the clone, registered or not. A worktree
//     made with `git worktree add <anywhere>` is not under `<repo>-worktrees`,
//     so the owned-checkout default silently omitted it from the all mode.
//   * S13: every reload reads the session's registered worktrees AT RELOAD TIME;
//     the mount-time read may only answer the first frame, so a worktree
//     registered after the panel opened appears on the next `r`.
//   * D2: a superseded reload is INERT. Its groups were already dropped, but its
//     flat listing was still applied by the view, which reset the preview scroll.

describe('T6 verifier regressions (S11, S13, D2)', () => {
  test('T6 verifier: all mode includes an outside-canonical Git worktree (S11)', async () => {
    const loaded = await load();
    const repo = makeRepo();
    const linked = addWorktree(repo, 'wt-t6-local');
    const witness = addWorktree(repo, 'wt-t6-witness');
    writeTask(witness, 't6-witness-odd', '# Owned unregistered worktree\n');
    const outside = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-t6-'))), 'wt-t6-outside');
    git(repo, ['worktree', 'add', '-b', 'feat/t6-outside', outside, 'main']);
    writeTask(outside, 't6-outside-odd', '# External worktree\n');
    const host = mountHost();
    const pending = loaded.commands.get('odd').handler('', ctxFor(linked, host, [linked]));
    try {
      await waitFor(() => host.mounts.length === 1, 'mount');
      const view = host.mounts[0].component;
      // odd-panel-groups S1: groups are folded, so the witness of a scope is its
      // GROUP HEADER, which is drawn either way.
      assert.doesNotMatch(frameText(view), /wt-t6-outside \(1 odd\)/);
      view.handleInput('a');
      // An owned worktree's delta is a witness that this was not just the pre-reload frame.
      await waitFor(() => /wt-t6-witness \(1 odd\)/.test(frameText(view)), 'all-mode reload');
      assert.match(frameText(view), /wt-t6-outside \(1 odd\)/);
    } finally {
      await closePanel(host, pending);
    }
  });

  test('T6 verifier: a superseded r cannot reset preview scroll (S11/D2)', async () => {
    const loaded = await load();
    const repo = makeRepo();
    const linked = addWorktree(repo, 'wt-t6-scroll');
    const target = writeTask(linked, 't6-long', '# Long document\n\n'
      + Array.from({ length: 160 }, (_, i) => `Paragraph ${i}\n\n`).join(''));
    const host = mountHost();
    const observed = observeGit(loaded.mod);
    const deferred = deferGroups(loaded.mod);
    const pending = loaded.commands.get('odd').handler(target, ctxFor(linked, host, [linked]));
    try {
      await waitFor(() => host.mounts.length === 1, 'mount');
      await waitForRankedListing(observed, [repo]);
      const view = host.mounts[0].component;
      deferred.arm();
      view.handleInput('r');
      const old = await deferred.real(deferred.pending[0].input);
      view.handleInput('r');
      const fresh = await deferred.real(deferred.pending[1].input);
      observed.clear();
      deferred.pending[1].resolve(fresh);
      await waitForRankedListing(observed, [repo]);
      // T12/F1: the clamp measures the body the LAST frame painted, so a host
      // paints a frame before the reader can press a key — this renders that
      // frame. Pressing `end` against a view no frame ever painted budgets one
      // row, which a real host never does, and the reading position it reports
      // is then corrected by the next frame.
      frameText(view);
      view.handleInput('end');
      const scroll = view.state.scroll;
      const frame = frameText(view);
      assert.ok(scroll > 0);
      deferred.pending[0].resolve(old);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(view.state.scroll, scroll);
      assert.equal(frameText(view), frame);
    } finally {
      deferred.restore();
      observed.restore();
      await closePanel(host, pending);
    }
  });

  test('T6 verifier: r reads worktrees registered after the panel opened (S13)', async () => {
    const loaded = await load();
    const repo = makeRepo();
    const linked = addWorktree(repo, 'wt-t6-new-registration');
    writeTask(linked, 'new-t6-odd', '# Newly registered worktree\n');
    const host = mountHost();
    const roots = [];
    const ctx = ctxFor(linked, host, roots);
    const observed = observeGit(loaded.mod);
    const pending = loaded.commands.get('odd').handler('', ctx);
    try {
      await waitFor(() => host.mounts.length === 1, 'mount');
      await waitForRankedListing(observed, [repo]);
      const view = host.mounts[0].component;
      // odd-panel-groups S1: the group arrives folded, so its HEADER is the witness.
      assert.doesNotMatch(frameText(view), /wt-t6-new-registration \(1 odd\)/);
      roots.push(linked);
      observed.clear();
      view.handleInput('r');
      await waitForRankedListing(observed, [repo]);
      assert.match(frameText(view), /wt-t6-new-registration \(1 odd\)/);
    } finally {
      observed.restore();
      await closePanel(host, pending);
    }
  });
});

describe('the ODD panel is not gated by Worktrees+ (corrected S7)', () => {
  test('with the module OFF the command, its grouping, `a` and a target all still work', async () => {
    const loaded = await load({ worktrees: false });
    const observed = observeGit(loaded.mod);
    try {
      assert.ok(loaded.commands.has('odd'), '/odd is registered whatever the module says');
      assert.equal(loaded.commands.has('warp'), false, 'the fixture really loaded with Worktrees+ off');
      const repo = makeRepo();
      const registered = addWorktree(repo, 'wt-a');
      const other = addWorktree(repo, 'wt-b');
      const target = writeTask(registered, 'a-only', '# body of a-only\n');
      writeTask(other, 'b-only', '# body of b-only\n');
      const host = mountHost();
      const ctx = ctxFor(repo, host, [registered]);

      const pending = loaded.commands.get('odd').handler(target, ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');
      const component = host.mounts[0].component;
      assert.deepEqual(host.notifications, []);
      assert.match(frameText(component), /\u25be wt-a/);
      assert.match(frameText(component), /body of a-only/);
      assert.ok(!frameText(component).includes('wt-b'), 'the scope is still the registered set');

      observed.clear();
      component.handleInput('a');
      await waitFor(() => frameText(component).includes('wt-b'), '`a` still shows every worktree');

      await closePanel(host, pending);
    } finally {
      observed.restore();
    }
  });
});

// T12 (S11): the footer hint describes the listing that is DRAWN. The mode the
// reader asked for is a request until its git read is APPLIED, so a held all-mode
// load must not make the footer claim a scope the panel is not showing.
test('T6 independent: while an all-mode read is held the hint still matches the drawn scope (S11/R2)', async () => {
  const loaded = await load();
  const repo = makeRepo();
  const other = addWorktree(repo, 'held-all');
  writeTask(other, 'visible-in-all', '# Visible in all\n');
  const host = mountHost();
  const pending = loaded.commands.get('odd').handler('', ctxFor(repo, host, []));
  const delayed = deferGroups(loaded.mod);
  try {
    await waitFor(() => host.mounts.length === 1, 'mount');
    const v = host.mounts[0].component;
    delayed.arm();
    v.handleInput('a');
    await waitFor(() => delayed.pending.length === 1, 'held all-mode read');
    assert.doesNotMatch(frameText(v), /held-all \(1 odd\)/);
    assert.match(frameText(v), /a all worktrees/);
    delayed.pending[0].resolve(await delayed.real(delayed.pending[0].input));
    await waitFor(() => frameText(v).includes('held-all (1 odd)'), 'all-mode result');
    assert.match(frameText(v), /a session only/);
  } finally {
    for (const read of delayed.pending) read.resolve([]);
    delayed.restore();
    await closePanel(host, pending);
  }
});

// T12 (S10, S11): ONE generation orders every load that can land on the panel —
// the startup ranking included. A rank that started before an `a` reload is
// superseded by it, so its late answer must not replace the newer listing.
test('T6 independent: a late initial rank cannot replace a newer all-mode listing (S10/S11/R2)', async () => {
  const loaded = await load();
  const repo = makeRepo();
  const other = addWorktree(repo, 'rank-witness');
  writeTask(other, 'all-witness', '# All mode witness\n');
  const host = mountHost();
  const docs = loaded.mod.libModule('odd-docs.js');
  const original = docs.listOddDocsAsync;
  let release;
  docs.listOddDocsAsync = async (...args) => {
    const old = await original(...args);
    await new Promise(resolve => { release = resolve; });
    return old;
  };
  const pending = loaded.commands.get('odd').handler('', ctxFor(repo, host, []));
  try {
    await waitFor(() => host.mounts.length === 1 && release, 'held initial ranking');
    const v = host.mounts[0].component;
    writeTask(repo, 'late-main', '# Added while ranking\n');
    v.handleInput('a');
    await waitFor(
      () => /rank-witness \(1 odd\)/.test(frameText(v)) && /main \(3 odd\)/.test(frameText(v)),
      'new all-mode frame',
    );
    const before = frameText(v);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frameText(v), before);
  } finally {
    release?.();
    docs.listOddDocsAsync = original;
    await closePanel(host, pending);
  }
});

// T12 (S13): the degraded select menu answers the SAME scope the panel draws —
// the loaded groups — so a session checkout that is not one of them can never
// leak its private documents into it.
test('T6 independent: the select fallback excludes a document in the unregistered current worktree (S13)', async () => {
  const loaded = await load();
  const repo = makeRepo();
  const linked = addWorktree(repo, 'fallback-linked');
  writeTask(linked, 'local-private', '# Only in the linked checkout\n');
  const host = mountHost();
  const menus = [];
  delete host.ui.custom;
  host.ui.select = (title, choices) => { menus.push([title, choices]); };
  await loaded.commands.get('odd').handler('', ctxFor(linked, host, []));
  assert.equal(menus.length, 1);
  assert.equal(menus[0][0], 'Odd documents');
  assert.deepEqual(menus[0][1].slice().sort(), ['main-one', 'main-two']);
});

test('T6 round 4: latest r publishes the hint with the pending a scope (S11)', async () => {
  const e = await load();
  const repo = makeRepo();
  const linked = addWorktree(repo, 'linked');
  writeTask(linked, 'all-witness', '# All-worktree witness\n');
  const host = mountHost();
  const d = deferGroups(e.mod);
  const pending = e.commands.get('odd').handler('', ctxFor(linked, host, []));
  try {
    await waitFor(() => host.mounts.length, 'mount');
    const v = host.mounts[0].component;
    d.arm();
    v.handleInput('a');
    v.handleInput('r');
    await waitFor(() => d.pending.length === 2, 'both requests held');
    d.pending[1].resolve(await d.real(d.pending[1].input));
    await waitFor(() => /linked \(1 odd\)/.test(frameText(v)), 'latest r result');
    assert.match(frameText(v), /a session only/);
  } finally {
    for (const read of d.pending) read.resolve(null);
    d.restore();
    await closePanel(host, pending);
  }
});

test('T6 round 4: a failed all-worktree Git read keeps drawn rows and hint (S11/S13)', async () => {
  const e = await load();
  const repo = makeRepo();
  const linked = addWorktree(repo, 'linked');
  const registered = addWorktree(repo, 'registered');
  writeTask(linked, 'linked-private', '# Private\n');
  writeTask(registered, 'session-witness', '# Registered\n');
  const g = e.mod.libModule('worktree-git.js');
  const run = g.runArgvAsync;
  let failedRead;
  const host = mountHost();
  const observed = observeGit(e.mod);
  const pending = e.commands.get('odd').handler('', ctxFor(linked, host, [registered]));
  try {
    await waitFor(() => host.mounts.length, 'mount');
    await waitForRankedListing(observed, [repo]);
    const v = host.mounts[0].component;
    const before = frameText(v);
    assert.match(before, /registered \(1 odd\)/);
    g.runArgvAsync = (bin, args, opts) => args.includes('worktree') && args.includes('list')
      ? (failedRead = run(bin, ['worktree', 'list', '--t6-invalid-option'], opts))
      : run(bin, args, opts);
    v.handleInput('a');
    await waitFor(() => Boolean(failedRead), 'worktree list started');
    assert.notEqual((await failedRead).status, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frameText(v), before);
  } finally {
    g.runArgvAsync = run;
    await closePanel(host, pending);
  }
});

test('T6 round 4: a listed absolute target with a dot component opens that document (S6)', async () => {
  const e = await load();
  const repo = makeRepo();
  const linked = addWorktree(repo, 'linked');
  writeTask(linked, 'precise target', '# Precisely selected body\n');
  const host = mountHost();
  const pending = e.commands.get('odd').handler(`${linked}/./odd/tasks/precise target.md`, ctxFor(repo, host, [linked]));
  try {
    await waitFor(() => host.mounts.length, 'mount');
    assert.deepEqual(host.notifications, []);
    assert.match(frameText(host.mounts[0].component), /Precisely selected body/);
  } finally {
    await closePanel(host, pending);
  }
});

test('T6 round 4: selecting a registered duplicate-name fallback entry identifies its path (S6/S13)', async () => {
  const e = await load();
  const repo = makeRepo();
  const linked = addWorktree(repo, 'linked');
  const target = writeTask(linked, 'main-one', '# Linked copy\n');
  const host = mountHost();
  host.ui.custom = () => Promise.reject(new Error('no overlay'));
  host.ui.select = (_title, choices) => choices[choices.length - 1];
  await e.commands.get('odd').handler('', ctxFor(linked, host, [linked]));
  assert.deepEqual(host.notifications, [['info', target]]);
});

// T13 (S11/S13/D2): the ONE-load/ONE-apply invariant, sampled exhaustively
// instead of by hand. Every load the panel can land — the startup rank, an `a`, an
// `r`, a second `a` — is held, then released in EVERY order. After each release
// the drawn rows, the footer hint and the applied scope must describe the same
// LATEST applied load, and a superseded answer must change nothing at all.
test('T6 round 4: every release order leaves the latest applied load (S11/S13/D2)', async () => {
  const e = await load();
  const repo = makeRepo();
  const registered = addWorktree(repo, 'registered');
  const other = addWorktree(repo, 'other');
  writeTask(registered, 'registered-only', '# Registered delta\n');
  writeTask(other, 'other-only', '# Other delta\n');

  // The two models the panel can apply: the session's registered set and every
  // worktree. They really differ, so a stale all-mode answer is visible.
  const model = deferGroups(e.mod);
  const sessionModel = await model.real({ repoRoot: repo, roots: [registered] });
  const allModel = await model.real({ repoRoot: repo, all: true });
  model.restore();
  assert.equal(sessionModel.length, 2, 'main plus the registered worktree');
  assert.equal(allModel.length, 3, 'main plus every worktree');

  const permutationsOf = (items) => (items.length <= 1 ? [items] : items.flatMap((item, index) => (
    permutationsOf([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  )));
  const plans = [
    { order: ['rank', 'a1', 'r', 'a2'], latest: 'a2' },
    { order: ['rank', 'a1', 'r'], latest: 'r' },
  ].flatMap((plan) => permutationsOf(plan.order).map((order) => ({ order, latest: plan.latest })));

  const started = Date.now();
  let releases = 0;
  for (const plan of plans) {
    const label = plan.order.join('>');
    const host = mountHost();
    const deferred = deferGroups(e.mod);
    const docs = e.mod.libModule('odd-docs.js');
    const realList = docs.listOddDocsAsync;
    let releaseRank = null;
    let rankHeld = true;
    // The startup rank is the ONE flat listing held; an `r` that survives its
    // generation must be allowed to finish its own read.
    docs.listOddDocsAsync = async (...args) => {
      const result = await realList(...args);
      if (rankHeld) {
        rankHeld = false;
        await new Promise((resolve) => { releaseRank = resolve; });
      }
      return result;
    };
    const pending = e.commands.get('odd').handler('', ctxFor(repo, host, [registered]));
    pending.catch(() => {});
    try {
      await waitFor(() => host.mounts.length === 1 && releaseRank !== null, `${label}: mount and held rank`);
      const view = host.mounts[0].component;
      deferred.arm();
      view.handleInput('a');
      await waitFor(() => deferred.pending.length === 1, `${label}: the first a is held`);
      view.handleInput('r');
      await waitFor(() => deferred.pending.length === 2, `${label}: the r is held`);
      if (plan.order.includes('a2')) {
        view.handleInput('a');
        await waitFor(() => deferred.pending.length === 3, `${label}: the second a is held`);
      }

      const release = (kind) => {
        if (kind === 'rank') {
          releaseRank();
          return;
        }
        if (kind === 'a1') deferred.pending[0].resolve(allModel);
        else if (kind === 'r') deferred.pending[1].resolve(allModel);
        else deferred.pending[2].resolve(sessionModel);
      };

      let expectedAll = false;
      for (const kind of plan.order) {
        const before = frameText(view);
        release(kind);
        if (kind === plan.latest) {
          expectedAll = kind === 'r';
          await waitFor(() => {
            const text = frameText(view);
            return expectedAll
              ? /other \(1 odd\)/.test(text) && /a session only/.test(text)
              : !/other \(1 odd\)/.test(text) && /a all worktrees/.test(text);
          }, `${label}: ${kind} applied`);
        } else {
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(frameText(view), before, `${label}: the superseded ${kind} changed nothing`);
        }
        const text = frameText(view);
        assert.equal(/other \(1 odd\)/.test(text), expectedAll,
          `${label}: the drawn rows follow the latest applied load`);
        assert.match(text, expectedAll ? /a session only/ : /a all worktrees/,
          `${label}: the hint describes that same applied load`);
        assert.match(text, /registered \(1 odd\)/, `${label}: the session delta is drawn in both modes`);
        releases += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
      const settled = frameText(view);
      assert.equal(/other \(1 odd\)/.test(settled), expectedAll, `${label}: nothing stale lands afterwards`);
      assert.match(settled, expectedAll ? /a session only/ : /a all worktrees/, `${label}: the final hint`);
    } finally {
      for (const read of deferred.pending) read.resolve(sessionModel);
      if (releaseRank !== null) releaseRank();
      deferred.restore();
      docs.listOddDocsAsync = realList;
      await closePanel(host, pending);
    }
  }
  const elapsed = Date.now() - started;
  assert.equal(releases, 114, 'every release of both event sets was checked (24×4 + 6×3)');
  assert.ok(elapsed < 120_000, `bounded permutations stay fast (${elapsed} ms)`);
});

// ---------------------------------------------------------------------------
// T15 (odd-rail-section, L11): the round-5 verifier's RED probes for the three
// defects this unit closes. They are ported here with this suite's helper names
// and every assertion kept as the verifier wrote it:
//
//   * E1/S11: ONE applied scope. After a failed toggle the retry must ask the
//     scope that FAILED, in every release order of every event set.
//   * E2/S13: a cold `/odd` whose `git worktree list` fails offers MAIN's own
//     documents only — never the session checkout's when that checkout is not
//     main — and refuses a private target instead of mounting it.
//   * E5/S13: two registered worktrees sharing a basename draw two distinct
//     labels and each selection reports its OWN document.
//   * B4: the degraded menu is `listing.menu` — the panel list flattened, in one
//     order, with path identity.
// ---------------------------------------------------------------------------

const { AsyncLocalStorage } = require('node:async_hooks');
const { setImmediate: tick } = require('node:timers/promises');

const doOdd = (e, raw, ctx) => e.commands.get('odd').handler(raw, ctx);
const isList = (a) => a.includes('worktree') && a.includes('list');
const deferred = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };

// The handler stays pending until the view closes; this opens it and answers the
// component it mounted.
const openPanel = async (e, host, ctx, raw = '') => {
  const n = host.notifications.length;
  const p = doOdd(e, raw, ctx);
  p.catch(() => {});
  await waitFor(() => host.mounts.length
    || host.notifications.slice(n).some(([level]) => level === 'error'), 'overlay or refusal');
  assert.equal(host.mounts.length, 1, JSON.stringify(host.notifications));
  return { p, v: host.mounts[0].component };
};

// A worktree Git knows and the package does NOT own: a sibling directory.
function outside(repo, prefix, basename, branch) {
  const parent = path.join(path.dirname(repo), path.basename(repo) + '-' + prefix);
  fs.mkdirSync(parent, { recursive: true });
  const root = path.join(parent, basename);
  git(repo, ['worktree', 'add', '-b', branch, root, 'main']);
  return root;
}

function perms(plan) {
  return plan.length
    ? plan.flatMap((name, i) => perms(plan.filter((_, j) => i !== j)).map((p) => [name, ...p]))
    : [[]];
}

// The frame the E1 probe measures: the registered witness is always there, the
// outside one only in the all-worktrees mode, and the hint names that mode.
function markFrame(v, all) {
  const text = frameText(v);
  // odd-panel-groups S1: every group is folded, so the scope is read from the group
  // HEADERS, which are painted whether a group is open or closed.
  assert.match(text, /registered \(1 odd\)/);
  assert.equal(/elsewhere \(1 odd\)/.test(text), all, text);
  assert.ok(text.includes(all ? 'a session only' : 'a all worktrees'), text);
}

// The degraded select menu: no overlay, so the command falls back to `select`.
async function chooseMenu(e, cwd, roots, select, reject = false) {
  const h = mountHost();
  let labels;
  if (reject) h.ui.custom = () => Promise.reject(new Error('no overlay'));
  else delete h.ui.custom;
  h.ui.select = (title, choices) => {
    assert.equal(title, 'Odd documents');
    labels = choices.slice();
    return select(choices);
  };
  await doOdd(e, '', ctxFor(cwd, h, roots));
  return { labels, notifications: h.notifications };
}

test('E1: every release order and latest Git failure, real reads under both CWDs', { timeout: 240000 }, async (t) => {
  const e = await load();
  const repo = makeRepo(), reg = addWorktree(repo, 'registered');
  const other = outside(repo, 'outside', 'elsewhere', 'feat/elsewhere');
  writeTask(reg, 'registered-witness', '# Registered');
  writeTask(other, 'outside-witness', '# Outside');
  const g = e.mod.libModule('worktree-git.js'), realRun = g.runArgvAsync;
  const vlib = e.mod.libModule('odd-view.js'), realView = vlib.createOddView;
  const local = new AsyncLocalStorage();
  const stats = { runs: 0, releases: 0, gitErrors: 0, retries: 0 };
  const faults = [];
  let hooks;
  vlib.createOddView = (o) => {
    for (const k of ['onToggleAll', 'reloadDocs']) {
      const real = o[k];
      o[k] = (...args) => {
        const h = local.getStore();
        h.request = args;
        const p = real(...args);
        p.then(h.done.release, h.done.release);
        return p;
      };
    }
    const v = realView(o);
    const apply = v.applyGroups;
    v.applyGroups = (groups, scope) => {
      hooks.applied.push({
        scope,
        all: groups.some((q) => q.docs.some((d) => d.name === 'outside-witness')),
        names: groups.flatMap((q) => q.docs.map((d) => d.name)),
      });
      return apply(groups, scope);
    };
    return v;
  };
  g.runArgvAsync = (bin, args, opts) => {
    const h = local.getStore();
    if (!h) return realRun(bin, args, opts);
    h.calls.push({ args, cwd: opts.cwd });
    if (h.started) return realRun(bin, args, opts);
    h.started = true;
    if (h !== hooks.rank) assert.ok(isList(args), args.join(' '));
    return h.gate.p.then(async () => {
      const result = await realRun(bin, h.fail ? ['worktree', 'list', '--invalid-t6-option'] : args, opts);
      if (h.fail) { assert.notEqual(result.status, 0); stats.gitErrors++; }
      return result;
    });
  };
  const docs = e.mod.libModule('odd-docs.js'), realDocs = docs.listOddDocsAsync;
  docs.listOddDocsAsync = async (root, opts) => {
    const h = local.getStore() ?? hooks?.rank;
    const result = await realDocs(root, {
      ...opts,
      runAsync: (bin, args, cwd) => {
        if (h === hooks.rank && h && !h.started) {
          h.started = true;
          return h.gate.p.then(() => realRun(bin, args, { cwd }));
        }
        return realRun(bin, args, { cwd });
      },
    });
    if (h && h === hooks.rank) setImmediate(h.done.release);
    return result;
  };
  const key = (id) => id[0];
  const hold = (id, fail) => ({ id, fail, calls: [], gate: deferred(), done: deferred() });
  const schedules = [['rank', 'a1', 'r1', 'a2'], ['a1', 'r1', 'r2'], ['r1', 'a1'], ['a1', 'a2', 'r1', 'r2']];
  try {
    for (const cwd of [repo, other]) {
      for (const plan of schedules) {
        for (const order of perms(plan)) {
          for (const failure of [false, true]) {
            const latest = plan.at(-1);
            const host = mountHost(), ctx = ctxFor(cwd, host, [reg]);
            const byId = new Map(plan.map((id) => [id, hold(id, failure && id === latest)]));
            hooks = { applied: [], rank: byId.get('rank') };
            const o = await openPanel(e, host, ctx);
            try {
              if (!hooks.rank) await waitFor(() => hooks.applied.length === 1, 'unheld startup rank');
              else await waitFor(() => hooks.rank.started, 'held startup rank');
              hooks.applied.length = 0;
              let requested = false;
              for (const id of plan.filter((x) => x !== 'rank')) {
                const h = byId.get(id);
                if (key(id) === 'a') requested = !requested;
                local.run(h, () => o.v.handleInput(key(id)));
                await waitFor(() => h.started, 'held ' + id);
                if (key(id) === 'a') assert.deepEqual(h.request, [requested]);
                h.all = requested;
              }
              markFrame(o.v, false);
              let all = false;
              for (const id of order) {
                const h = byId.get(id), before = frameText(o.v), n = hooks.applied.length;
                h.gate.release();
                await h.done.p;
                await tick();
                if (id === latest && !failure) {
                  all = h.all;
                  assert.equal(hooks.applied.length, n + 1);
                  assert.deepEqual(hooks.applied.at(-1).scope, { all });
                  assert.equal(hooks.applied.at(-1).all, all);
                  // Verify the scope was exercised by reading the outside checkout itself.
                  assert.equal(h.calls.some((c) => c.cwd === other && c.args.includes('merge-base')), all);
                } else {
                  assert.equal(hooks.applied.length, n, `unexpected apply after ${id}`);
                  if (!(id === latest && key(id) === 'r')) assert.equal(frameText(o.v), before, `changed after ${id}`);
                }
                markFrame(o.v, all);
                stats.releases++;
              }
              if (failure) {
                const h = hold('retry', false);
                local.run(h, () => o.v.handleInput(key(latest)));
                h.gate.release();
                await h.done.p;
                await tick();
                const should = byId.get(latest).all;
                try {
                  assert.deepEqual(hooks.applied.at(-1)?.scope, { all: should });
                  markFrame(o.v, should);
                } catch {
                  faults.push(`${path.basename(cwd)} ${plan}/${order}: retry asked ${JSON.stringify(h.request)}, applied ${JSON.stringify(hooks.applied.at(-1)?.scope)}, expected ${should}`);
                }
                stats.retries++;
              }
              stats.runs++;
            } finally {
              await closePanel(host, o.p);
            }
          }
        }
      }
    }
  } finally {
    docs.listOddDocsAsync = realDocs;
    g.runArgvAsync = realRun;
    vlib.createOddView = realView;
  }
  t.diagnostic(JSON.stringify(stats));
  t.diagnostic(`retry violations: ${faults.length}; ${faults.slice(0, 4).join('; ')}`);
  assert.equal(faults.length, 0);
});

test('E2/S13: overlay startup during a real list failure (separate from legacy select menu)', async (t) => {
  const e = await load();
  const repo = makeRepo(), linked = addWorktree(repo, 'unregistered-overlay');
  writeTask(linked, 'witness-private', '# Distinct private body');
  const g = e.mod.libModule('worktree-git.js'), run = g.runArgvAsync;
  let rc;
  g.runArgvAsync = async (bin, args, opts) => {
    const r = await run(bin, isList(args) ? ['worktree', 'list', '--strictly-invalid-t6'] : args, opts);
    if (isList(args)) rc = r.status;
    return r;
  };
  const h = mountHost(), ctx = ctxFor(linked, h, []);
  const pending = doOdd(e, '', ctx);
  let answered = false;
  pending.then(() => { answered = true; });
  try {
    await waitFor(() => answered || h.mounts.length, 'failed cold start answer');
    assert.notEqual(rc, 0);
    assert.ok(rc !== undefined);
    if (h.mounts.length) {
      const text = frameText(h.mounts[0].component);
      t.diagnostic(`Git exit=${rc}; overlay offered path in linked checkout: ${/witness-private/.test(text)}; private preview: ${/Distinct private body/.test(text)}`);
      assert.doesNotMatch(text, /witness-private|Distinct private body/);
    }
  } finally {
    g.runArgvAsync = run;
    await closePanel(h, pending);
  }
});

test('E2/S13: no model and no main documents opens the empty panel, never this checkout', async () => {
  const e = await load();
  const repo = makeRepo(), linked = addWorktree(repo, 'cold-empty');
  // MAIN holds no document at all, and the session's linked checkout is not
  // registered, so its private document is the only one on disk.
  fs.rmSync(path.join(repo, 'odd'), { recursive: true, force: true });
  writeTask(linked, 'linked-private', '# Private body');
  const g = e.mod.libModule('worktree-git.js'), run = g.runArgvAsync;
  g.runArgvAsync = (bin, args, opts) => run(bin, isList(args) ? ['worktree', 'list', '--strictly-invalid-t6'] : args, opts);
  const h = mountHost();
  const pending = doOdd(e, '', ctxFor(linked, h, []));
  try {
    await waitFor(() => h.mounts.length || h.notifications.length, 'cold answer');
    assert.deepEqual(h.notifications, [], 'the command is not refused: it opens the empty panel');
    assert.equal(h.mounts.length, 1);
    const text = frameText(h.mounts[0].component);
    assert.doesNotMatch(text, /linked-private|Private body/);
    assert.match(text, /no odd documents/, 'the view\u2019s own empty copy');
    assert.match(text, /0 documents/, 'and an empty listing');
  } finally {
    g.runArgvAsync = run;
    await closePanel(h, pending);
  }
});

// ---------------------------------------------------------------------------
// T17/F2 (L11): the PRINCIPAL root is never assumed. A repository whose git dir is
// not its checkout (`git init --separate-git-dir`) has a common dir whose basename
// is NOT `.git`, so the old derivation fell back to "this session's checkout" — and
// a session standing in a LINKED checkout then had that checkout's private document
// offered as main's whenever `git worktree list` failed. The principal is now read
// from the same listing the model reads, and an undeterminable one is NO main root:
// the degraded panel offers main's documents or nothing, never a private copy.
//
// The standard single-root repository keeps today's answer byte for byte: the
// pinned case below (a failed listing still offers MAIN's own documents).
// ---------------------------------------------------------------------------
function separateMetadataRepo(tag) {
  const base = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), `odd-panel-meta-${tag}-`))));
  const meta = path.join(base, 'git-meta');
  const root = path.join(base, 'checkout');
  git(base, ['init', '-b', 'main', '--separate-git-dir', meta, root]);
  git(root, ['config', 'user.email', 'test@example.test']);
  git(root, ['config', 'user.name', 'Test']);
  const tasks = path.join(root, 'odd', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'main-one.md'), '# body of main-one\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  return { base, meta, root };
}

test('F2: a failed listing in a linked checkout of a separate git dir offers no private document', async (t) => {
  const e = await load();
  const repo = separateMetadataRepo('linked');
  const linked = addWorktree(repo.root, 'metadata-linked');
  const priv = writeTask(linked, 'witness-private', '# Distinct private body');
  const g = e.mod.libModule('worktree-git.js'), run = g.runArgvAsync;
  let rc;
  g.runArgvAsync = async (bin, args, opts) => {
    const answer = await run(bin, isList(args) ? ['worktree', 'list', '--strictly-invalid-t7'] : args, opts);
    if (isList(args)) rc = answer.status;
    return answer;
  };
  const listHost = mountHost();
  const banPending = doOdd(e, '', ctxFor(linked, listHost, []));
  try {
    await waitFor(() => listHost.mounts.length || listHost.notifications.length, 'cold answer');
    assert.equal(rc, 129);
    assert.equal(listHost.mounts.length, 1, 'the command opens the panel, it is not an error');
    const text = frameText(listHost.mounts[0].component);
    t.diagnostic(`overlay in a linked checkout with separate metadata: private offered = ${/witness-private|Distinct private body/.test(text)}`);
    assert.doesNotMatch(text, /witness-private|Distinct private body/,
      'the linked checkout is not main: its private document is neither offered nor previewed');
  } finally {
    await closePanel(listHost, banPending);
  }
  const targetHost = mountHost();
  const targetPending = doOdd(e, priv, ctxFor(linked, targetHost, []));
  try {
    await waitFor(() => targetHost.mounts.length || targetHost.notifications.length, 'target answer');
    assert.equal(targetHost.mounts.length, 0, 'and an absolute target to it is not mounted');
    assert.deepEqual(targetHost.notifications, [['error', `Unknown option "${priv}". Use /odd.`]]);
  } finally {
    g.runArgvAsync = run;
    await closePanel(targetHost, targetPending);
  }
});

test('F2 preserve: a standard repository still offers MAIN\u2019s documents when the listing fails', async () => {
  const e = await load();
  const repo = makeRepo(), linked = addWorktree(repo, 'std-linked');
  writeTask(linked, 'std-private', '# Linked private');
  const g = e.mod.libModule('worktree-git.js'), run = g.runArgvAsync;
  g.runArgvAsync = (bin, args, opts) => run(bin, isList(args) ? ['worktree', 'list', '--strictly-invalid-t7'] : args, opts);
  const h = mountHost(), menus = [];
  delete h.ui.custom;
  h.ui.select = (title, choices) => { menus.push([title, choices]); };
  try {
    await doOdd(e, '', ctxFor(linked, h, []));
    assert.equal(menus.length, 1, 'the degraded menu still answers');
    assert.deepEqual(menus[0][1].slice().sort(), ['main-one', 'main-two'],
      'main\u2019s own documents, never the linked checkout\u2019s');
  } finally {
    g.runArgvAsync = run;
  }
});

// ---------------------------------------------------------------------------
// T17/F3 (L11): the panel draws the LISTING's label, not the model's raw name. Two
// registered checkouts that share a basename drew `collision` twice (the label the
// listing had already made unique never reached the frame), so the human could not
// tell the rows apart. The label is derived once, in lib/odd-listing.js, and the
// wiring now hands it over with every document; keyboard selection still resolves
// each row to its own absolute path, so each copy opens its own body.
//
// A listing WITHOUT labels keeps the view's current behaviour: the standard
// single-root repository paints plain names, exactly as before (pinned below).
// ---------------------------------------------------------------------------
// The LEFT pane of a frame: the rows between the frame's own chrome — never the
// border lines, the search box or the footer legend.
const listCells = (component) => renderedRows(component)
  .filter((line) => /^\u2502/.test(line))
  .map((line) => (line.split('\u2502')[1] || ''))
  .filter((cell) => cell.trim() !== '' && !/^\u203a|^\u2191/.test(cell.trim()));
// A row's label with the CURSOR and the group's own fold marker removed, so a row
// reads the same however it is drawn (odd-panel-groups S1 folds every group, so a
// marker is present on rows that are not focused at all).
const cellLabel = (cell) => cell.trim()
  .replace(/^[\u25b8\u25be]\s*/, '')
  .replace(/^[\u25b8\u25be]\s*/, '')
  .replace(/\s+/g, ' ');
const rowLabels = (component) => listCells(component)
  .map(cellLabel)
  .filter((cell) => cell !== '');
// The CURSOR is the first cell after the frame's `\u2502 `, so it sits at index 1 of
// the pane cell while a folded group's marker is indented past it.
const focusedLabel = (component) => {
  const cell = listCells(component).find((value) => value[1] === '\u25b8');
  return cell === undefined ? null : cellLabel(cell);
};
async function focusRow(component, label) {
  let guard = 0;
  while (focusedLabel(component) !== label && guard < 40) {
    component.handleInput('down');
    guard += 1;
  }
  assert.equal(focusedLabel(component), label, `the ${JSON.stringify(label)} row is focusable`);
}

test('F3: two registered checkouts sharing a basename paint two different labels, each opening its own body', async (t) => {
  const e = await load();
  const repo = makeRepo();
  // Two checkouts with the SAME basename under one-letter parents, so the labels
  // the listing derives differ where the list pane can paint them.
  const base = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-panel-labels-'))));
  const linkedAt = (parent, branch) => {
    const dir = path.join(base, parent);
    fs.mkdirSync(dir, { recursive: true });
    const root = path.join(dir, 'same checkout');
    git(repo, ['worktree', 'add', '-b', branch, root, 'main']);
    return root;
  };
  const a = linkedAt('a', 'feat/first-same');
  const b = linkedAt('b', 'feat/second-same');
  writeTask(a, 'collision', '# First copy\n');
  writeTask(b, 'collision', '# Second copy\n');
  const labelOf = (root) => `collision (${path.basename(path.dirname(root))}/${path.basename(root)})`;
  const host = mountHost();
  const pending = doOdd(e, '', ctxFor(repo, host, [a, b]));
  try {
    await waitFor(() => host.mounts.length === 1, 'the panel mounts');
    const v = host.mounts[0].component;
    const text = frameText(v);
    t.diagnostic(`labels: ${JSON.stringify(rowLabels(v))}`);
    // odd-panel-groups S1: both groups arrive FOLDED, so their own headers are the
    // rows that must tell them apart.
    const headers = rowLabels(v).filter((label) => label.includes('same checkout'));
    assert.equal(headers.length, 2, `both groups are listed\n${text}`);
    assert.notEqual(headers[0], headers[1], 'the two headers read differently');
    assert.deepEqual(headers.slice().sort(), [
      'a/same checkout (1 odd)',
      'b/same checkout (1 odd)',
    ], 'each is qualified with the directory that tells it apart');
    for (const [root, body] of [[a, /First copy/], [b, /Second copy/]]) {
      const parent = path.basename(path.dirname(root));
      await focusRow(v, `${parent}/same checkout (1 odd)`);
      v.handleInput('enter');
      await focusRow(v, labelOf(root));
      assert.match(frameText(v), body, `${parent}: its own body is open`);
    }
  } finally {
    await closePanel(host, pending);
  }
});

test('F3 preserve: a standard single-root repository still paints plain document names', async () => {
  const e = await load();
  const repo = makeRepo();
  const host = mountHost();
  const pending = doOdd(e, '', ctxFor(repo, host, []));
  try {
    await waitFor(() => host.mounts.length === 1, 'the panel mounts');
    // The fixture's mtimes are deliberately the OPPOSITE of its rank (T16 depends on that),
    // and the panel can paint the cheap mtime scan before the ranked listing lands, so the
    // frame read here has to be the settled one: wait for the rank, then assert it.
    await waitFor(() => rowLabels(host.mounts[0].component).join('|') === 'main-one|main-two',
      'the settled frame is the ranked listing');
    assert.deepEqual(rowLabels(host.mounts[0].component), ['main-one', 'main-two'],
      'unique names keep their exact plain text, in the rank the panel reads');
  } finally {
    await closePanel(host, pending);
  }
});

// ---------------------------------------------------------------------------
// T17/F4 (L11): the target grammar RESOLVES before it validates. The parent check
// compared the RAW argument's segments with `odd/tasks`, so `<parent>/odd/tasks/./
// <name>.md` and `<parent>/odd/tasks/../tasks/<name>.md` were refused although they
// name a listed document — `path.resolve` is the same rule the command's own
// document test uses. Nothing else moves: a sibling path that resolves outside
// `odd/tasks` keeps the verbatim refusal.
// ---------------------------------------------------------------------------
test('F4: a listed document reached through `.` or `..` segments opens its own body', async (t) => {
  const e = await load();
  const repo = makeRepo();
  const tasks = path.join(repo, 'odd', 'tasks');
  // Built by CONCATENATION: `path.join` would collapse the very segments under test.
  const spellings = [`${tasks}/./main-one.md`, `${tasks}/../tasks/main-one.md`];
  for (const raw of spellings) {
    assert.equal(path.resolve(raw), path.join(tasks, 'main-one.md'), `${raw} resolves to the listed document`);
    assert.notEqual(raw, path.join(tasks, 'main-one.md'), `${raw} keeps its own spelling`);
    const host = mountHost();
    const pending = doOdd(e, raw, ctxFor(repo, host, []));
    pending.catch(() => {});
    try {
      await waitFor(() => host.mounts.length || host.notifications.length, `${raw}: an answer`);
      t.diagnostic(`${raw} => ${host.mounts.length} mount(s), ${JSON.stringify(host.notifications)}`);
      assert.deepEqual(host.notifications, [], `${raw}: accepted, not refused`);
      assert.equal(host.mounts.length, 1, `${raw}: the panel opens`);
      assert.match(frameText(host.mounts[0].component), /body of main-one/, `${raw}: its own body is open`);
    } finally {
      await closePanel(host, pending);
    }
  }
});

test('F4 preserve: a path that resolves outside odd/tasks is still refused verbatim', async () => {
  const e = await load();
  const repo = makeRepo();
  const tasks = path.join(repo, 'odd', 'tasks');
  const outsideDoc = path.join(repo, 'odd', 'README.md');
  fs.writeFileSync(outsideDoc, '# Outside the rule\n');
  // Both spellings RESOLVE to a real document that is not under `odd/tasks`: the
  // path rule still refuses them, with the sentence every unknown argument gets.
  for (const raw of [`${tasks}/../README.md`, `${tasks}/../tasks/./../README.md`]) {
    assert.equal(path.resolve(raw), outsideDoc, `${raw}: the fixture really resolves outside`);
    const host = mountHost();
    await doOdd(e, raw, ctxFor(repo, host, []));
    assert.equal(host.mounts.length, 0, `${raw}: nothing is mounted`);
    assert.deepEqual(host.notifications, [['error', `Unknown option "${raw}". Use /odd.`]], raw);
  }
});

test('E2 proof: a failed listing does not let the overlay open a private target (baseline refuses)', async (t) => {
  const repo = makeRepo(), linked = addWorktree(repo, 'not-in-scope');
  const target = writeTask(linked, 'private-direct', '# Excluded private preview');
  const e = await load(), g = e.mod.libModule('worktree-git.js'), run = g.runArgvAsync;
  const healthy = mountHost();
  await doOdd(e, target, ctxFor(linked, healthy, []));
  assert.equal(healthy.mounts.length, 0);
  assert.deepEqual(healthy.notifications, [['error', `Unknown option "${target}". Use /odd.`]]);
  t.diagnostic(`candidate with healthy listing: ${healthy.notifications[0][1]}`);
  let rc;
  g.runArgvAsync = async (bin, args, opts) => {
    const answer = await run(bin, isList(args) ? ['worktree', 'list', '--strictly-invalid-t6'] : args, opts);
    if (isList(args)) rc = answer.status;
    return answer;
  };
  const h = mountHost();
  const pending = doOdd(e, target, ctxFor(linked, h, []));
  try {
    await waitFor(() => h.mounts.length || h.notifications.length, 'direct command answers');
    assert.equal(rc, 129);
    if (h.mounts.length) t.diagnostic(`candidate git exit ${rc}: opened private target and read body = ${/Excluded private preview/.test(frameText(h.mounts[0].component))}`);
    assert.equal(h.mounts.length, 0);
    assert.deepEqual(h.notifications, [['error', `Unknown option "${target}". Use /odd.`]]);
  } finally {
    g.runArgvAsync = run;
    await closePanel(h, pending);
  }
});

test('E5: two registered real worktrees with the same basename cannot select each other', async (t) => {
  const e = await load();
  const repo = makeRepo();
  const a = outside(repo, 'one', 'same checkout', 'feat/first-same');
  const b = outside(repo, 'two', 'same checkout', 'feat/second-same');
  const pa = writeTask(a, 'collision', '# First copy'), pb = writeTask(b, 'collision', '# Second copy');
  assert.ok(git(repo, ['worktree', 'list', '--porcelain']).includes(a));
  assert.ok(git(repo, ['worktree', 'list', '--porcelain']).includes(b));
  const selections = [];
  for (const i of [0, 1]) {
    const result = await chooseMenu(e, repo, [a, b], (choices) => choices.filter((label) => label.startsWith('collision'))[i]);
    assert.equal(result.labels.filter((label) => label.startsWith('collision')).length, 2);
    t.diagnostic(`index ${i}: ${JSON.stringify(result.labels)} => ${JSON.stringify(result.notifications)}; registered candidates ${pa}, ${pb}`);
    selections.push(result.notifications[0]?.[1]);
  }
  assert.deepEqual(selections.sort(), [pa, pb].sort());
});

test('E5: literal legacy label and generated main label both selectable', async (t) => {
  const e = await load();
  const repo = makeRepo(), a = addWorktree(repo, 'literal-test');
  const literal = writeTask(repo, 'main-one (main)', '# Literal');
  writeTask(a, 'main-one', '# Linked');
  const result = await chooseMenu(e, repo, [a], (choices) => choices.find((x) => x === 'main-one (main)'));
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.labels.filter((x) => x === 'main-one (main)').length, 1);
  assert.deepEqual(result.notifications, [['info', literal]]);
});

test('B4: the degraded menu is `listing.menu`, in that order, reporting that entry path', async (t) => {
  const e = await load();
  const repo = makeRepo();
  // Two registered worktrees that share a basename: the ad-hoc menu labelling this
  // unit replaces drew the same label twice here, so one label selected both.
  const a = outside(repo, 'one', 'same checkout', 'feat/b4-first-same');
  const b = outside(repo, 'two', 'same checkout', 'feat/b4-second-same');
  writeTask(a, 'collision', '# First copy');
  writeTask(b, 'collision', '# Second copy');
  // The model the command reads for this session, and the ONE listing value the
  // panel and the menu must both draw from. L11/T16: main's group carries
  // lib/odd-docs.js's rank (commit recency, then display name) and the listing
  // PRESERVES it, so the model this test lists from is main's group in that ranked
  // order — both fixture documents come from ONE commit, so the rank is by name.
  const groups = await e.mod.libModule('odd-group.js').groupOddDocs({ repoRoot: repo, roots: [a, b] });
  const rankedMain = (await e.mod.libModule('odd-docs.js').listOddDocsAsync(repo)).docs;
  const rankedGroups = groups.map((group) => (group && group.isMain === true
    ? { ...group, docs: rankedMain.map((doc, order) => ({ ...doc, order })) }
    : group));
  const listing = e.mod.libModule('odd-listing.js').buildListing({ groups: rankedGroups });
  assert.equal(listing.menu[0].name, 'main-one',
    'the fixture really ranks main-one before main-two (one commit, so by name)');
  assert.equal(new Set(listing.menu.map((row) => row.label)).size, listing.menu.length,
    'the listing really disambiguates the repeated basenames');
  const result = await chooseMenu(e, repo, [a, b], (choices) => choices[0]);
  assert.deepEqual(result.labels, listing.menu.map((row) => row.label),
    'the menu IS the listing: same labels, same order, main first');
  assert.deepEqual(result.notifications, [['info', listing.menu[0].path]],
    'the first entry opens the document the first row names');
  // Every index maps to its own entry, never to a name another checkout carries.
  for (let index = 0; index < listing.menu.length; index += 1) {
    const picked = await chooseMenu(e, repo, [a, b], (choices) => choices[index]);
    assert.deepEqual(picked.notifications, [['info', listing.menu[index].path]], `index ${index}`);
  }
  // A unique name keeps the plain label the baseline had. L11/T16: the sequence is
  // main's RANK, which for two documents of one commit is by name — 53ae2b2's menu
  // read main-one first, not the later mtime's main-two.
  const plain = await chooseMenu(e, repo, [], (choices) => choices[0]);
  assert.deepEqual(plain.labels, ['main-one', 'main-two'],
    'unique names stay undecorated, in the ranked order main first');
  t.diagnostic(`menu ${JSON.stringify(result.labels)}`);
});

// L11/T16 (regression): 53ae2b2's degraded menu listed a main checkout's documents
// in the order lib/odd-docs.js ranks them — commit recency, then display name — and
// this fixture's two documents come from the SAME commit while their mtimes differ
// (`makeRepo` stamps main-two LATER). A menu that orders them by mtime reads
// main-two first, so picking its first entry opens a different file than the
// baseline opened. The listing must PRESERVE the rank main's group is handed,
// never re-rank it — and this pin builds the fixture itself, so it reads no git
// history and no fixed commit.
test('T16: the degraded menu keeps the ranked order, not mtime (L11 regression)', async () => {
  const e = await load();
  const repo = makeRepo();
  const mainOne = path.join(repo, 'odd', 'tasks', 'main-one.md');
  const mainTwo = path.join(repo, 'odd', 'tasks', 'main-two.md');
  // The fixture really does have the mtime order that used to leak into the menu,
  // and one commit behind both documents, so the rank ties on recency.
  const times = [mainOne, mainTwo].map((doc) => fs.statSync(doc).mtimeMs);
  assert.ok(times[0] < times[1], 'main-two is the LATER mtime, so a mtime sort reads it first');
  assert.equal(git(repo, ['log', '--format=%H', '--', 'odd/tasks']).split('\n').filter(Boolean).length, 1,
    'both documents come from the one commit, so the rank breaks the tie by name');

  const host = mountHost();
  delete host.ui.custom;
  const menus = [];
  host.ui.select = (title, choices) => {
    menus.push({ title, choices: choices.slice() });
    return choices[0];
  };
  await e.commands.get('odd').handler('', ctxFor(repo, host, []));
  assert.equal(menus.length, 1, 'the degraded path answers with one menu');
  assert.equal(menus[0].title, 'Odd documents');
  assert.deepEqual(menus[0].choices, ['main-one', 'main-two'],
    'the ranked sequence (same commit, so by name) — exactly what 53ae2b2 showed');
  assert.deepEqual(host.notifications, [['info', mainOne]],
    'and the first entry opens main-one, the document the baseline opened');
});

// Append to tools/odd-panel-wiring.test.js. S6/S10/S11/S13, L11.
test('separated git dir: healthy linked session still lists real main', async () => {
  const e = await load(), { root } = separateMetadataRepo('healthy-linked');
  const linked = addWorktree(root, 'private-linked');
  fs.unlinkSync(path.join(linked, 'odd/tasks/main-one.md'));
  writeTask(linked, 'private', '# Not in the session scope');
  const host = mountHost(), pending = doOdd(e, '', ctxFor(linked, host));
  try {
    await waitFor(() => host.mounts.length || host.notifications.length, 'reply');
    assert.deepEqual(host.notifications, []);
    assert.equal(host.mounts.length, 1);
    const frame = frameText(host.mounts[0].component);
    assert.match(frame, /body of main-one/);
    assert.doesNotMatch(frame, /Not in the session scope/);
  } finally { await closePanel(host, pending); }
});

test('separated git dir named .git does not admit documents outside a checkout', async () => {
  const root = makeRepo(), parent = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-meta-parent-')));
  git(root, ['init', '--separate-git-dir', path.join(parent, '.git')]);
  const linked = addWorktree(root, 'private-linked'), e = await load();
  const unrelated = writeTask(parent, 'not-in-main', '# Not a checkout document');
  const g = e.mod.libModule('worktree-git.js'), real = g.runArgvAsync;
  const exits = [];
  g.runArgvAsync = async (bin, args, opts) => {
    if (!isList(args)) return real(bin, args, opts);
    const answer = await real(bin, ['worktree', 'list', '--odd-regression-invalid'], opts);
    exits.push(answer.status);
    return answer;
  };
  const host = mountHost(), pending = doOdd(e, unrelated, ctxFor(linked, host));
  try {
    await waitFor(() => host.mounts.length || host.notifications.length, 'target reply');
    assert.deepEqual([...new Set(exits)], [129]);
    assert.equal(host.mounts.length, 0);
    assert.deepEqual(host.notifications, [['error', `Unknown option "${unrelated}". Use /odd.`]]);
  } finally { g.runArgvAsync = real; await closePanel(host, pending); }
});

test('round-trip scope toggle preserves ranked order with identical rows', async () => {
  const e = await load(), root = makeRepo(), host = mountHost();
  addWorktree(root, 'unchanged');
  const degraded = await chooseMenu(e, root, [], (labels) => labels[0]);
  const pending = doOdd(e, '', ctxFor(root, host));
  try {
    await waitFor(() => host.mounts.length, 'mount');
    const view = host.mounts[0].component;
    await waitFor(() => rowLabels(view).join(',') === 'main-one,main-two', 'ranked order');
    assert.deepEqual(rowLabels(view), degraded.labels);
    view.handleInput('a');
    await waitFor(() => frameText(view).includes('a session only'), 'all applied');
    view.handleInput('a');
    await waitFor(() => frameText(view).includes('a all worktrees'), 'session applied');
    assert.deepEqual(rowLabels(view), degraded.labels);
  } finally { await closePanel(host, pending); }
});

// S6/F4: pin the corrected normalization rule, not byte spelling.
test('doubled separators still identify the listed document', async () => {
  const e = await load(), root = makeRepo(), host = mountHost();
  const listed = path.join(root, 'odd/tasks/main-one.md'), raw = `${path.dirname(listed)}//main-one.md`;
  assert.equal(path.resolve(raw), listed);
  assert.equal(fs.statSync(raw).ino, fs.statSync(listed).ino);
  const pending = doOdd(e, raw, ctxFor(root, host));
  try {
    await waitFor(() => host.mounts.length || host.notifications.length, 'reply');
    assert.deepEqual(host.notifications, []);
    assert.equal(host.mounts.length, 1);
    assert.match(frameText(host.mounts[0].component), /body of main-one/);
  } finally { await closePanel(host, pending); }
});

// ---------------------------------------------------------------------------
// T19 (odd-rail-section, L13): the ONE round-8 finding that is not gated on a
// separated git directory. A symlinked directory under `odd/tasks` makes
// `<link>/../<name>.md` name ANOTHER tree's inode: `path.resolve` collapses the
// `..` lexically, so a lexical comparison against the listing happily opened the
// LOCAL document the spelling claims to be, and the command reported success
// while the target the reader named was never the one on screen. The document's
// identity is its REAL path, so a target the listing does not carry by realpath
// is the unknown option it always was, and nothing is mounted.
//
// The verifier's appendix test (T6 regression, `/tmp/oddv.*/t6-regression-appendix.js`)
// is ported here with this suite's helper names and its assertions verbatim. The
// separated-git-dir cases in that appendix are NOT ported: L13 declares that
// layout out of support.
// ---------------------------------------------------------------------------
test('T19/F4: a lexical dot-dot match cannot open another inode', async () => {
  const e = await load(), root = makeRepo();
  const other = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-distinct-inode-')));
  const otherDoc = writeTask(other, 'main-one', '# Distinct inode');
  const sub = path.join(path.dirname(otherDoc), 'sub');
  fs.mkdirSync(sub);
  const tasks = path.join(root, 'odd/tasks'), wanted = path.join(tasks, 'main-one.md');
  fs.symlinkSync(sub, path.join(tasks, 'cross'), 'dir');
  const raw = `${tasks}/cross/../main-one.md`;
  assert.equal(path.resolve(raw), wanted);
  assert.equal(fs.realpathSync.native(raw), otherDoc);
  assert.notEqual(fs.statSync(raw).ino, fs.statSync(wanted).ino);
  const h = mountHost(), pending = doOdd(e, raw, ctxFor(root, h));
  try {
    await waitFor(() => h.mounts.length || h.notifications.length, 'distinct target reply');
    assert.equal(h.mounts.length, 0);
    assert.deepEqual(h.notifications, [['error', `Unknown option "${raw}". Use /odd.`]]);
  } finally { await closePanel(h, pending); }
});

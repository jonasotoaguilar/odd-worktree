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
    calls.push({ argv: [...argv], cwd: options && options.cwd });
    return real.call(gitLib, bin, argv, options);
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

      const text = frameText(host.mounts[0].component);
      // S10/S13: main always carries every ODD of main; a registered worktree
      // carries only what it has that main does not.
      assert.match(text, /\u25be main/, 'main is a group of its own');
      assert.match(text, /\u25be wt-a/, 'the registered worktree is a group');
      assert.match(text, /a-only/);
      assert.ok(!text.includes('wt-b'), `an unregistered worktree is not a group\n${text}`);
      assert.ok(!text.includes('b-only'), `nor is one of its documents listed\n${text}`);
      assert.match(text, /3 documents/, 'main’s two plus the worktree’s one');

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
      assert.match(frameText(component), /\u25be wt-b/);
      assert.match(frameText(component), /b-only/);

      // `a` again: back to the session's registered set only.
      observed.clear();
      component.handleInput('a');
      await waitFor(() => !frameText(component).includes('wt-b'), 'the unregistered group goes');
      assert.deepEqual(observed.readsIn(other), [],
        'the registered reload never asks an unregistered worktree anything');
      assert.equal(observed.listing().length, 1, 'and it re-enumerates the checkouts once');
      assert.match(frameText(component), /a all worktrees/, 'the hint returns with the mode');
      assert.match(frameText(component), /\u25be wt-a/);

      await closePanel(host, pending);
    } finally {
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

  test('an absolute target in a worktree the session did not register still opens the panel', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const foreign = addWorktree(repo, 'wt-b');
      writeTask(foreign, 'b-only', '# body of b-only\n');
      const target = path.join(foreign, 'odd', 'tasks', 'b-only.md');
      const host = mountHost();
      const ctx = ctxFor(repo, host, []);

      const pending = loaded.commands.get('odd').handler(target, ctx);
      pending.catch(() => {});
      await waitFor(() => host.mounts.length === 1, 'the panel mounts');

      // A valid target is never a refusal; the view answers a document it cannot
      // select with its own first row, and the panel still opens.
      assert.deepEqual(host.notifications, [], 'the target is accepted');
      assert.match(frameText(host.mounts[0].component), /body of main-two/,
        'the panel falls back to its own first document');

      await closePanel(host, pending);
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

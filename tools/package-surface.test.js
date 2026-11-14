'use strict';
// S2/S4 surface: the standalone package always registers /warp, /odd-list and
// /issues plus the TWO agent worktree tools (S3/S4: `worktree_delete` and
// `worktree_warp` are not registered, so `/warp` is the only front that moves
// the session and the panel's ctrl+d the only one that removes a checkout),
// loads in plain Pi with git as its only external dependency, and ships none of
// the removed functionality
// (customize panel, plugin-tools toggles, worktree mode file, perf tracing,
// CodeGraph commands or a CodeGraph gate).
// The issues reader, preview formatter and view are the migrated T2 units and
// are shipped; `/issues` is the T3 command that mounts them, without any
// worktree↔issue association.
//
// Everything here reads the observable surface: the registered command and
// tool objects, the manifest, the files on disk. No internal state is read.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LIB_DIR, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

describe('manifest', () => {
  test('declares one Pi extension entry point and ships only that surface', () => {
    assert.equal(PKG.name, 'pi-odd-worktree');
    assert.ok(PKG.keywords.includes('pi-package'), 'keywords name the pi-package kind');
    assert.deepEqual(PKG.pi.extensions, ['./extensions/odd-worktree-tools.ts']);
    for (const entry of ['extensions', 'lib', 'tools', 'README.md']) {
      assert.ok(PKG.files.includes(entry), `files ships ${entry}`);
    }
    assert.equal(PKG.peerDependencies['@earendil-works/pi-coding-agent'], '*');
    assert.equal(PKG.peerDependencies['@earendil-works/pi-tui'], '*');
    assert.ok(!('dependencies' in PKG), 'no runtime dependencies are installed');
    assert.equal(/herdr/i.test(JSON.stringify(PKG)), false, 'the manifest claims no integration the package does not have');
  });

  test('ships no module for the removed commands', () => {
    const shipped = fs.readdirSync(path.join(ROOT, 'lib')).sort();
    for (const gone of [
      'issues-cache.js',
      'herdr-plugin-check.js',
      'gentle-sidebar.js',
      'perf-trace.js',
      'perf-analyze.js',
      'host-settings.js',
      'worktree-mode.js',
      'moshi-prereq.js',
      'live-session-changes.js',
    ]) {
      assert.equal(shipped.includes(gone), false, `lib/${gone} is not shipped`);
    }
    // The issue reader, preview formatter and view are the migrated units (T2
    // S1,S3): the per-tab cache is still gone, but the `gh` client, the
    // formatter and the issues view `/issues` mounts are shipped, so their
    // presence is asserted rather than forbidden.
    for (const kept of ['gh-issues.js', 'issue-preview.js', 'issues-view.js', 'warp-selector-view.js', 'odd-view.js', 'worktree-git.js', 'worktree-registry.js', 'worktree-session-guard.js']) {
      assert.ok(shipped.includes(kept), `lib/${kept} is shipped`);
    }
  });
});

describe('registration', () => {
  test('registers /warp, /odd-list, /issues and the two worktree tools', async () => {
    delete process.env.GENTLE_WORKTREE_THREAD;
    const { commands, tools, messageRenderers } = await loadExtension({});
    const registered = [...commands.keys()].sort();
    assert.deepEqual(registered, ['issues', 'odd-list', 'warp'], 'the command list is exactly the three panels');
    assert.deepEqual([...tools.keys()].sort(), ['worktree_create', 'worktree_list'], 'exactly two agent tools');
    assert.deepEqual([...messageRenderers.keys()], ['worktree-warp']);
  });

  test('every tool keeps its declared name and description', async () => {
    const { tools } = await loadExtension({});
    const summary = (name) => {
      const tool = tools.get(name);
      return { name: tool.name, label: tool.label };
    };
    assert.deepEqual(summary('worktree_create'), { name: 'worktree_create', label: 'Worktree Create' });
    assert.deepEqual(summary('worktree_list'), { name: 'worktree_list', label: 'Worktree List' });
  });

  // S3/S4: neither removal nor warp is an agent surface any more, so nothing the
  // model can call names them. The guard they both used still refuses a live
  // session (tools/worktree-tools.test.js), and the panel still discloses its
  // caveats (tools/warp-delete-confirm.test.js) — those are the surviving checks.
  test('no tool deletes a checkout or moves the session', async () => {
    const { tools } = await loadExtension({});
    assert.equal(tools.has('worktree_delete'), false, 'no delete tool is registered');
    assert.equal(tools.has('worktree_warp'), false, 'no warp tool is registered');
    const source = stubbedSource();
    assert.equal(/registerTool\(worktreeCloseTool\)/.test(source), false, 'the close tool stays unregistered');
    assert.equal(/registerTool\(worktreeWarpTool\)/.test(source), false, 'the warp tool stays unregistered');
    assert.equal(/herdr/i.test(source), false, 'no Herdr workspace removal is promised anywhere');
  });
});

describe('removed surface', () => {
  test('the extension names no customize or Herdr-panel surface', () => {
    const source = stubbedSource();
    assert.equal(/herdr-gentle:/.test(source), false, 'no herdr-gentle: command name survives');
    for (const gone of ['registerCustomizeCommand', 'executeWorktreeSessionOpen', 'startAgentSessionWatcher', 'customizePluginToolEnabled']) {
      assert.equal(source.includes(gone), false, `${gone} is gone`);
    }
    for (const lib of ['worktree-mode.js', 'herdr-plugin-check.js', 'perf-trace.js']) {
      assert.equal(source.includes(`libRequire("${lib}")`), false, `${lib} is not required`);
    }
  });

  test('the extension probes, registers and runs no CodeGraph surface (S2)', async () => {
    const source = stubbedSource();
    assert.equal(/codegraph/i.test(source), false, 'the extension source mentions no CodeGraph at all');
    const { commands, hooks } = await loadExtension({});
    for (const gone of ['codegraph-hook', 'codegraph-init', 'codegraph-sync']) {
      assert.equal(commands.has(gone), false, `no /${gone} command`);
    }
    assert.equal(
      hooks.some(([name]) => name === 'tool_result') && /scheduleSync/.test(source),
      false,
      'no edit/write sync hook is registered',
    );
    for (const shipped of fs.readdirSync(path.join(ROOT, 'lib'))) {
      assert.equal(/^codegraph-/.test(shipped), false, `lib/${shipped} is not shipped`);
    }
  });

  test('the /issues command keeps its migrated client and view', () => {
    const source = stubbedSource();
    assert.ok(source.includes('pi.registerCommand("issues"'), 'the /issues command is registered');
    assert.ok(source.includes('function registerIssuesCommand'), 'its registration is a named step');
    assert.ok(source.includes('libRequire("gh-issues.js")'), 'the reader uses the migrated gh client');
    assert.ok(source.includes('libRequire("issues-view.js")'), 'the reader mounts the migrated view');
  });

  test('the loaded extension holds no reference to the removed packages', async () => {
    const { commands } = await loadExtension({});
    for (const gone of ['customize', 'odd', 'herdr-gentle:warp']) {
      assert.equal(commands.has(gone), false, `no /${gone} command`);
    }
    assert.equal(commands.has('issues'), true, '/issues is the migrated command');
    // Modules only: `lib/` also holds the prompt prose (`lib/odd-prompt/*.md`),
    // which no module reads through `require`.
    for (const file of fs.readdirSync(path.join(ROOT, 'lib'))) {
      if (!fs.statSync(path.join(LIB_DIR, file)).isFile()) continue;
      const text = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
      assert.equal(/require\(['"]\.\/gh-issues\.js['"]\)/.test(text), false, `lib/${file} does not pull the issues reader`);
    }
  });
});

// ---- how the extension loads its own lib/ modules ----
//
// Pi loads an extension with jiti `moduleCache: false`
// (`@earendil-works/pi-coding-agent` dist/core/extensions/loader.js:
// `createJitiImpl(import.meta.url, { moduleCache: false, ... })`), so the
// extension file is re-read on every load. Node's own require cache is a
// different cache and it outlives a load, so a reloaded extension used to run
// against the lib modules of the FIRST load. These cases prove the observable
// half of that: a module rewritten on disk is seen by the NEXT load, and only by
// the next load.
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

// The listing module this test rewrites: nothing else of the tool is replaced, so
// what the assertion reads is the module on disk, reached through the public tool.
const listingProbe = (marker) => [
  "'use strict';",
  `const MARKER = ${JSON.stringify(marker)};`,
  'module.exports = {',
  '  worktreeListView: () => ({ text: MARKER, details: { worktrees: [], hiddenOutside: 0 } }),',
  '};',
  '',
].join('\n');

// The git seam the list reads, faked so this case spawns no child: a repository
// root and one main checkout are all `worktree_list` needs to reach the view.
const gitStub = (root) => [
  "'use strict';",
  `const ROOT = ${JSON.stringify(root)};`,
  'module.exports = {',
  '  runArgvAsync: async () => ({ status: 1, stdout: "", stderr: "" }),',
  '  repoIdentityAsync: async () => ({ root: ROOT }),',
  '  listWorktreesAsync: async () => [{ path: ROOT, branch: "main", head: "1a2b3c4" }],',
  '};',
  '',
].join('\n');

/** Register an already-imported extension module against a fake host and hand back what the host received. */
async function registered(copy) {
  const mod = await import(pathToFileURL(copy).href);
  const tools = new Map();
  const messageRenderers = new Map();
  const hooks = [];
  mod.default({
    registerCommand: () => {},
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerMessageRenderer: (type, renderer) => { messageRenderers.set(type, renderer); },
    on: (event, handler) => { hooks.push([event, handler]); },
  });
  return { mod, tools, messageRenderers, hooks };
}

/** Load the extension against `libDir`, exactly as the host loads it: a fresh module each time. */
async function loadFromLibDir(libDir) {
  process.env.GENTLE_WORKTREE_LIB_DIR = libDir;
  const copy = path.join(scratch('odd-ext-load-'), 'odd-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbedSource());
  return registered(copy);
}

const listText = async (tools, cwd) => {
  const result = await tools.get('worktree_list').execute('probe', {}, undefined, undefined, { cwd });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.content.map((part) => part.text).join('');
};

describe('the extension loads its lib modules once per load', () => {
  const savedLibDir = process.env.GENTLE_WORKTREE_LIB_DIR;
  after(() => {
    if (savedLibDir === undefined) delete process.env.GENTLE_WORKTREE_LIB_DIR;
    else process.env.GENTLE_WORKTREE_LIB_DIR = savedLibDir;
  });

  test('a rewritten module is seen by the next extension load, and only by it', async () => {
    const libDir = path.join(scratch('odd-lib-fresh-'), 'lib');
    fs.cpSync(LIB_DIR, libDir, { recursive: true });
    const root = fs.realpathSync(scratch('odd-lib-root-'));
    fs.writeFileSync(path.join(libDir, 'worktree-git.js'), gitStub(root));
    fs.writeFileSync(path.join(libDir, 'worktree-list.js'), listingProbe('probe: first'));

    const first = await loadFromLibDir(libDir);
    assert.equal(await listText(first.tools, root), 'probe: first', 'the first load reads the module on disk');

    fs.writeFileSync(path.join(libDir, 'worktree-list.js'), listingProbe('probe: second'));

    assert.equal(await listText(first.tools, root), 'probe: first', 'one load reads its lib modules once, never again per call');

    const second = await loadFromLibDir(libDir);
    assert.notEqual(second.mod, first.mod, 'a load is a new extension instance');
    assert.equal(await listText(second.tools, root), 'probe: second', 'a reloaded extension runs the NEW module, not the one the first load cached');
    assert.equal(await listText(second.tools, root), 'probe: second', 'and it keeps reading it for its whole lifetime');
  });

  test('with no override the extension reads the lib/ beside itself', async () => {
    // The production layout: <pkg>/extensions/<entry> with <pkg>/lib beside it, and
    // no GENTLE_WORKTREE_LIB_DIR set at all.
    const pkg = scratch('odd-pkg-');
    fs.mkdirSync(path.join(pkg, 'extensions'));
    fs.cpSync(LIB_DIR, path.join(pkg, 'lib'), { recursive: true });
    const copy = path.join(pkg, 'extensions', 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    delete process.env.GENTLE_WORKTREE_LIB_DIR;
    const { tools } = await registered(copy);
    // A directory outside any repository is refused by the READ module, so the
    // answer proves the package's own lib directory resolved to real modules.
    const loose = fs.realpathSync(scratch('odd-lib-loose-'));
    const result = await tools.get('worktree_list').execute('probe', {}, undefined, undefined, { cwd: loose });
    assert.equal(result.isError, true);
    assert.equal(result.content.map((part) => part.text).join(''), `not a git repository: ${loose}`);
  });
});

// ---- the click seam, wired end to end ----
//
// pi-tui's alternate screen delivers a click only to the component that claimed
// the press, and the component it reaches is the one the host put in the
// transcript — the card the render hook returned. These cases drive the
// registered surfaces, so the wiring between the host toggle and the three cards
// is asserted where a reader would see it: a click expands, another collapses.
const probeMetrics = {
  visibleWidth: (value) => [...value.replace(/\x1b\[[0-9;]*m/g, '')].length,
  truncateToWidth: (value, width, ellipsis = '') => {
    const text = value.replace(/\x1b\[[0-9;]*m/g, '');
    if (width <= 0) return '';
    if ([...text].length <= width) return value;
    return `${[...text].slice(0, Math.max(0, width - [...String(ellipsis ?? '')].length)).join('')}${String(ellipsis ?? '')}`;
  },
  wrapTextWithAnsi: (value, width) => {
    const text = value.replace(/\x1b\[[0-9;]*m/g, '');
    if (width <= 0) return [text];
    const rows = [];
    const chars = [...text];
    while (chars.length > width) rows.push(chars.splice(0, width).join(''));
    rows.push(chars.join(''));
    return rows;
  },
};

const probeTheme = { fg: (_role, value) => value };

function mouse(component, rows, type, x = 3, y = 0) {
  return component.handleMouse({
    type,
    button: 'left',
    x,
    y,
    width: 60,
    height: rows.length,
    screenX: x,
    screenY: y,
    shift: false,
    alt: false,
    ctrl: false,
  });
}

describe('a click expands every worktree card', () => {
  test('the two tool cards and the warp card flip the host flag on a click', async () => {
    const { mod, tools, messageRenderers, hooks } = await loadFromLibDir(LIB_DIR);
    const flag = { expanded: false, writes: [] };
    const ui = {
      getToolsExpanded: () => flag.expanded,
      setToolsExpanded: (value) => {
        flag.expanded = value;
        flag.writes.push(value);
      },
    };
    // The extension remembers the session's UI handle in its FIRST session_start
    // hook, which is the only way a render hook can reach the host flag.
    const startHook = hooks.find(([name]) => name === 'session_start');
    assert.ok(startHook, 'the extension registers a session_start hook');
    startHook[1]({}, { hasUI: true, ui });

    try {
      mod.setWorktreeToolCardMetrics(probeMetrics);
      const context = { isPartial: false, keyHint: (_name, text) => `ctrl+o ${text}` };
      for (const name of ['worktree_create', 'worktree_list']) {
        const component = tools.get(name).renderCall({}, probeTheme, context);
        const rows = component.render(60);
        assert.equal(typeof component.handleMouse, 'function', `${name}: the card carries the click seam`);
        assert.deepEqual(mouse(component, rows, 'press'), { handled: true, render: false }, `${name}: the press claims the card`);
        assert.deepEqual(mouse(component, rows, 'click'), { handled: true }, `${name}: the click is handled`);
        assert.deepEqual(mouse(component, rows, 'click'), { handled: true });
      }
      assert.deepEqual(flag.writes, [true, false, true, false], 'four clicks on the two tool cards flipped the host flag four times');

      const warp = messageRenderers.get('worktree-warp');
      const message = { customType: 'worktree-warp', content: 'session warped to feat-two', details: { fromName: 'feat-one', name: 'feat-two', to: '/clone-worktrees/feat-two', branch: 'feat/two' } };
      const card = warp(message, {}, probeTheme);
      const cardRows = card.render(60);
      assert.ok(cardRows.length > 1, 'the warp card draws');
      assert.equal(typeof card.handleMouse, 'function', 'the warp card carries the click seam');
      assert.deepEqual(mouse(card, cardRows, 'press'), { handled: true, render: false });
      assert.deepEqual(mouse(card, cardRows, 'click'), { handled: true });
      assert.equal(flag.expanded, true, 'the warp card flips the same host flag');
    } finally {
      mod.setWorktreeToolCardMetrics(undefined);
    }
  });

  test('with no host UI the cards stay keyboard-only', async () => {
    const { mod, tools, messageRenderers, hooks } = await loadFromLibDir(LIB_DIR);
    const startHook = hooks.find(([name]) => name === 'session_start');
    startHook[1]({}, { hasUI: false });
    try {
      mod.setWorktreeToolCardMetrics(probeMetrics);
      const component = tools.get('worktree_list').renderCall({}, probeTheme, { isPartial: false });
      assert.equal('handleMouse' in component, false, 'no UI, no click seam');
      const warp = messageRenderers.get('worktree-warp')({ customType: 'worktree-warp', content: '', details: {} }, {}, probeTheme);
      assert.equal('handleMouse' in warp, false, 'and no warp click either');
    } finally {
      mod.setWorktreeToolCardMetrics(undefined);
    }
  });
});

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

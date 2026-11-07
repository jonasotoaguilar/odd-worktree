'use strict';
// S2/S4 surface: the standalone package registers exactly three commands
// (/warp, /odd-list and /issues) and the four agent worktree tools, loads
// without any Herdr binary, and ships none of the removed functionality
// (customize panel, plugin-tools toggles, worktree mode file, perf tracing).
// The issues reader, preview formatter and view are the migrated T2 units and
// are shipped; `/issues` is the T3 command that mounts them, without any
// worktree↔issue association.
//
// Everything here reads the observable surface: the registered command and
// tool objects, the manifest, the files on disk. No internal state is read.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LIB_DIR, SRC, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

// A nonexistent absolute path is provably not a live Herdr binary, so the
// shared resolver returns it and every Herdr call fails instead of reaching a
// real workspace.
const NO_HERDR = path.join(os.tmpdir(), 'odd-worktree-no-such-herdr-binary');

describe('manifest', () => {
  test('declares one Pi extension entry point and ships only that surface', () => {
    assert.equal(PKG.name, '@jonasotoaguilar/odd-worktree');
    assert.ok(PKG.keywords.includes('pi-package'), 'keywords name the pi-package kind');
    assert.deepEqual(PKG.pi.extensions, ['./extensions/odd-worktree-tools.ts']);
    for (const entry of ['extensions', 'lib', 'tools', 'README.md']) {
      assert.ok(PKG.files.includes(entry), `files ships ${entry}`);
    }
    assert.equal(PKG.peerDependencies['@earendil-works/pi-coding-agent'], '*');
    assert.equal(PKG.peerDependencies['@earendil-works/pi-tui'], '*');
    assert.ok(!('dependencies' in PKG), 'no runtime dependencies are installed');
    assert.ok(!JSON.stringify(PKG).includes('herdr'), 'the manifest never requires Herdr');
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
  test('registers /warp, /odd-list, /issues and the four worktree tools', async () => {
    process.env.HERDR_BIN_PATH = NO_HERDR;
    delete process.env.GENTLE_WORKTREE_THREAD;
    const { commands, tools, messageRenderers } = await loadExtension({});
    assert.deepEqual([...commands.keys()].sort(), ['issues', 'odd-list', 'warp']);
    assert.deepEqual([...tools.keys()].sort(), ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_warp']);
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
    assert.deepEqual(summary('worktree_close'), { name: 'worktree_close', label: 'Worktree Close' });
    assert.deepEqual(summary('worktree_warp'), { name: 'worktree_warp', label: 'Worktree Warp' });
  });

  test('the close help text names the active-session refusal and no Herdr workspace', async () => {
    const { tools } = await loadExtension({});
    const description = tools.get('worktree_close').description;
    assert.match(description, /live Pi session working in that checkout/);
    assert.match(description, /warp to another checkout first/i);
    assert.match(description, /git/);
    assert.equal(/and its Herdr workspace/i.test(description), false, 'no Herdr workspace removal is promised');
    assert.match(description, /no Herdr workspace is closed, opened or removed/);
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
    for (const file of fs.readdirSync(path.join(ROOT, 'lib'))) {
      const text = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
      assert.equal(/require\(['"]\.\/gh-issues\.js['"]\)/.test(text), false, `lib/${file} does not pull the issues reader`);
    }
  });
});

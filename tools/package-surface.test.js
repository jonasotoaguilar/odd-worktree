'use strict';
// S4 surface: the standalone package always registers /warp, /odd, /files
// and /issues plus the TWO agent worktree tools (S3/S4: `worktree_delete` and
// `worktree_warp` are not registered, so `/warp` is the only front that moves
// the session and the panel's ctrl+d the only one that removes a checkout),
// loads in plain Pi with git as its only external dependency, and ships none of
// the removed functionality
// (customize panel, plugin-tools toggles, worktree mode file, perf tracing,
// CodeGraph commands, a CodeGraph gate or any CodeGraph probe or sync; the one
// CodeGraph touch is the append-only `## CodeGraph` prompt section).
// The issues reader, preview formatter and view are the migrated T2 units and
// are shipped; `/issues` is the T3 command that mounts them, without any
// worktree↔issue association.
//
// The bash activity is not a preference here: it is a design on gentle-shell-bridge's
// own `Card activity` line, so the shipped surface is exactly four commands, two tools, one
// sidebar section, one tools design and the one `Cards` row group the two file-card
// switches carry.
//
// Everything here reads the observable surface: the registered command and
// tool objects, the manifest, the files on disk. No internal state is read.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BRIDGE_SLOT, LIB_DIR, defaultBridge, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');

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
    // presence is asserted rather than forbidden. The bash drawing is the
    // classifier and the one design registered on the bridge. The file cards add
    // their own four modules — a classifier, the card, its resolver and the document
    // body Pi's Markdown draws — and own no preference at all (S1): they are gated by
    // the bridge's `Card activity` line, which is the bridge's, not ours. The user
    // prompt card is the one module that wraps a host class, and it adds no row, no
    // command and no design of its own.
    for (const kept of ['gh-issues.js', 'issue-preview.js', 'issues-view.js', 'warp-selector-view.js', 'odd-view.js', 'worktree-git.js', 'worktree-registry.js', 'worktree-session-guard.js', 'skill-read-guard.js', 'bash-activity.js', 'bash-inline-script.js', 'bash-design.js', 'bash-frame.js', 'diff-design.js', 'skill-odd-card.js', 'file-card.js', 'file-card-resolver.js', 'file-card-markdown.js', 'user-prompt-card.js']) {
      assert.ok(shipped.includes(kept), `lib/${kept} is shipped`);
    }
    for (const gone of ['card-files-mode.js', 'cards-customize.js']) {
      assert.equal(shipped.includes(gone), false, `lib/${gone} is gone (S1)`);
    }
  });
});

describe('registration', () => {
  test('registers /warp, /odd, /files, /issues and the two worktree tools', async () => {
    delete process.env.GENTLE_WORKTREE_THREAD;
    const { commands, tools, messageRenderers } = await loadExtension({});
    const registered = [...commands.keys()].sort();
    assert.deepEqual(registered, ['files', 'issues', 'odd', 'warp'], 'the command list is exactly the four panels');
    assert.deepEqual([...tools.keys()].sort(), ['worktree_create', 'worktree_list'], 'exactly two agent tools');
    assert.deepEqual([...messageRenderers.keys()], ['worktree-warp']);
  });

  // The bash activity is a design on the bridge's own line, not a preference. The
  // two file-card switches ARE preferences of this package: one strict document in
  // the Pi home for the pair, whose only control is the customize row group
  // contributed through the bridge API (asserted below), never a command of ours.
  test('the bash activity is a design, and this package owns no switch of its own', async () => {
    const source = stubbedSource();
    assert.ok(source.includes('libRequire("bash-design.js")'), 'the design reaches the bridge through its published API');
    assert.equal(source.includes('registerCommand("card:bash"'), false, 'the design has no command name');
    const lib = path.join(ROOT, 'lib');
    for (const gone of ['card-bash-mode.js', 'card-bash-customize.js', 'bash-card.js', 'bash-card-resolver.js']) {
      assert.equal(fs.existsSync(path.join(lib, gone)), false, `lib/${gone} is gone`);
    }

    // S1: the two file-card switches and their document are gone, and the extension
    // names neither. The file card is gated by the bridge's own `Card activity` line.
    assert.equal(source.includes('registerCardsCustomize'), false, 'no row provider is registered for a switch');
    assert.equal(source.includes('card-files'), false, 'the extension never names their document');
    const modules = fs.readdirSync(lib).filter((entry) => entry.endsWith('.js'));
    const writers = modules.filter((entry) => /writeCardFileSwitch\b/.test(fs.readFileSync(path.join(lib, entry), 'utf8')));
    assert.deepEqual(writers, [], 'no module writes a card-file switch any more');
    const { commands } = await loadExtension({});
    assert.equal(commands.has('card:bash'), false, 'no /card:bash command is registered');
    for (const gone of ['card-style', 'card-bash', 'card-skill', 'card-odd', 'customize', 'worktree-mode']) {
      assert.equal(commands.has(gone), false, `no /${gone} command`);
    }
  });

  test('the bridge is never imported, and the surface reaches it through its published object', () => {
    const source = stubbedSource();
    assert.equal(/from\s+["']gentle-shell-bridge/.test(source), false, 'no import of the bridge package anywhere');
    assert.equal(/require\(\s*["']gentle-shell-bridge/.test(source), false, 'no require of the bridge package anywhere');
    assert.equal(source.split('api.registerSection(').length - 1, 1, 'exactly one sidebar section is contributed');
  });

  test('the bash design is wired through exactly one registration and adds no name', async () => {
    const source = stubbedSource();
    assert.equal(source.split('design.registerBashDesign(').length - 1, 1, 'one registration call');
    assert.equal(source.includes('registerBashCard'), false, 'no resolver of ours draws bash');
    const { commands, tools } = await loadExtension({});
    for (const gone of ['bash-card', 'card-bash', 'bash']) {
      assert.equal(commands.has(gone), false, `the design adds no /${gone} command`);
      assert.equal(tools.has(gone), false, `the design adds no ${gone} tool`);
    }
  });

  test('the skill rules are two more hooks and add no name (invariant 22)', async () => {
    // invariant 22 (S5 of skill-read-full): the `tool_call` hooks are the naming handler, the
    // worktree bash and write guards, the skill-read bash guard and the whole-read rule, all of
    // them under `Worktrees+` — a sixth would be a surface nobody asked for.
    const source = stubbedSource();
    assert.equal(source.split('pi.on("tool_call"').length - 1, 5, 'the naming handler, the two worktree guards, the skill-read guard and the whole-read rule');
    assert.ok(source.includes('libRequire("skill-read-guard.js")'), 'the decision comes from lib/skill-read-guard.js');
    assert.ok(source.includes('libRequire("artifact-read-full.js")'), 'the whole-read decision comes from lib/artifact-read-full.js');
    const { commands, tools } = await loadExtension({});
    for (const gone of ['skill-read', 'skill_read', 'skill-read-guard']) {
      assert.equal(commands.has(gone), false, `the guard adds no /${gone} command`);
      assert.equal(tools.has(gone), false, `the guard adds no ${gone} tool`);
    }
  });

  test('both Card rows are registered once each, observed through the bridge\'s own object', async () => {
    // S2/S6: what a caller observes is the REGISTRATION, not a spelling in the source. A bridge
    // that publishes the release both lines need sees one design per line, each with its own id and
    // label, and nothing else — so a second registration, a renamed id or a third row fails here.
    const bridge = defaultBridge();
    bridge.api.VERSION = '0.9.0';
    const previous = globalThis[BRIDGE_SLOT];
    globalThis[BRIDGE_SLOT] = bridge.api;
    try {
      await loadExtension({});
      assert.deepEqual(
        bridge.designs.map((design) => [design.line, design.id, design.label]),
        [['activity', 'odd-worktree.bash-activity', 'activity'], ['diff', 'odd-worktree.diff', 'color']],
        'one design per line, once each',
      );
    } finally {
      globalThis[BRIDGE_SLOT] = previous;
    }
  });

  test('the file cards register through one hook call and own no preference (T2)', async () => {
    // S1/S7: the card is drawn through the host's `registerToolRenderer`, and the ONE switch
    // it obeys is the bridge's own line, asked through the published reader on every paint.
    // Nothing of ours is registered for it: no command, no tool, no row provider, no store.
    const source = stubbedSource();
    const lines = source.split('\n').map((line) => line.trim());
    assert.deepEqual(
      lines.filter((line) => line.includes('registerFileCard(')),
      ['libRequire("file-card-resolver.js").registerFileCard(pi, { metrics: () => resolveWorktreeToolCardMetrics() });'],
      'the file card is wired through exactly one call',
    );
    assert.equal(source.includes('registerCardsCustomize'), false, 'and no switch provider is wired at all');
    const { commands, tools } = await loadExtension({});
    for (const gone of ['file-card', 'card-skill', 'card-odd']) {
      assert.equal(commands.has(gone), false, `the card adds no /${gone} command`);
      assert.equal(tools.has(gone), false, `the card adds no ${gone} tool`);
    }
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

  test('CodeGraph is wired through one registration and adds no command or tool (S2)', async () => {
    const source = stubbedSource();
    // The extension mentions CodeGraph to require the prompt section, the one registration and the
    // CARD — which is a design of the `Card activity` line, registered outside the module switch; the
    // `Codegraph+` switch's own lines (`oddModules`) are the gate in front of the first two.
    const mentions = source.split('\n').filter((line) => !/oddModules/.test(line) && /codegraph/i.test(line.replace(/\/\/.*$/, '')));
    assert.deepEqual(
      mentions.map((line) => line.trim()),
      [
        'libRequire("codegraph-rules.js").appendCodegraphSection(event);',
        'libRequire("codegraph-session.js").registerCodegraph(pi, { metrics: () => resolveWorktreeToolCardMetrics() });',
        'libRequire("codegraph-card.js").registerCodegraphCard(pi, {',
      ],
      'the CodeGraph references in the extension are the prompt section, the one registration and the card',
    );
    const { commands, tools } = await loadExtension({});
    for (const gone of ['codegraph-hook', 'codegraph-init', 'codegraph-sync', 'codegraph']) {
      assert.equal(commands.has(gone), false, `no /${gone} command`);
      assert.equal(tools.has(gone), false, `no ${gone} tool`);
    }
    assert.deepEqual([...tools.keys()].sort(), ['worktree_create', 'worktree_list'], 'the model-facing tools are still exactly the two');
  });

  test('both worktree tools frame their own card, so the host draws no filled box under it', async () => {
    const { tools } = await loadExtension({});
    for (const name of ['worktree_create', 'worktree_list']) {
      assert.equal(tools.get(name).renderShell, 'self', `${name} declares renderShell: self`);
    }
  });

  test('worktree_create takes an optional base branch, and only that tool does', async () => {
    const { tools } = await loadExtension({});
    const create = tools.get('worktree_create').parameters;
    assert.ok(create.properties.base, 'worktree_create has a base parameter');
    // The host's schema builder is a shim in this harness, so optionality is read where it is
    // declared: `base` goes through `opt(...)` like `copy_changes`, `odd` and `branch` do not.
    const source = fs.readFileSync(path.join(ROOT, 'extensions', 'odd-worktree-tools.ts'), 'utf8');
    assert.match(source, /\n    base: opt\(Type\.String\(/, 'base is optional: nothing changes without it');
    assert.doesNotMatch(source, /\n    (odd|branch): opt\(/, 'odd and branch stay required');
    assert.match(tools.get('worktree_create').description, /`base`/, 'the description names it');
    assert.equal('base' in tools.get('worktree_list').parameters.properties, false, 'worktree_list is untouched');
  });

  test('the CodeGraph modules are a closed list with narrow powers (S1, S2)', () => {
    const lib = path.join(ROOT, 'lib');
    const shipped = fs.readdirSync(lib).filter((entry) => /^codegraph-/.test(entry)).sort();
    const allowed = [
      'codegraph-card-preview.js', 'codegraph-card.js', 'codegraph-compaction.js', 'codegraph-daemon.js',
      'codegraph-edit-sync.js', 'codegraph-guard-target.js', 'codegraph-guard.js', 'codegraph-index.js',
      'codegraph-lock.js', 'codegraph-mcp-config.js', 'codegraph-mcp.js', 'codegraph-paths.js', 'codegraph-prompt',
      'codegraph-role.js', 'codegraph-rules.js', 'codegraph-session.js', 'codegraph-warmup.js',
    ];
    for (const entry of shipped) assert.ok(allowed.includes(entry), `lib/${entry} is not an allowed CodeGraph module`);
    const read = (name) => fs.readFileSync(path.join(lib, name), 'utf8');
    // Code only: a comment may say what a module does not do.
    const code = (name) => read(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const entry of shipped.filter((name) => name.endsWith('.js'))) {
      const text = code(entry);
      for (const blocked of ['spawnSync', 'execSync', 'execFileSync']) {
        assert.equal(text.includes(blocked), false, `${entry} never uses ${blocked}`);
      }
    }
    // The prompt section only advises: it runs, probes and writes nothing.
    const rules = code('codegraph-rules.js');
    for (const forbidden of ['spawn', 'exec(', 'execFile', 'child_process', 'writeFile', 'codegraph.db']) {
      assert.equal(rules.includes(forbidden), false, `the prompt section module never uses ${forbidden}`);
    }
    // The user's MCP configuration has exactly one writer, and it touches only its own entry.
    for (const entry of shipped.filter((name) => name.endsWith('.js') && name !== 'codegraph-mcp-config.js')) {
      assert.equal(/mcp\.json/.test(read(entry).replace(/\/\/.*$/gm, '')) && /writeFile|rename\(/.test(read(entry)), false, `${entry} does not write mcp.json`);
    }
  });

  test('the two reminders advise only: one text, no surface, no child of their own', () => {
    const lib = path.join(ROOT, 'lib');
    const read = (name) => fs.readFileSync(path.join(lib, name), 'utf8');
    const code = (name) => read(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const entry of ['codegraph-guard.js', 'codegraph-guard-target.js']) {
      const text = code(entry);
      for (const forbidden of ['registerTool', 'registerCommand', 'ui.notify', 'writeFile', 'appendFile', 'rename(', 'child_process', 'spawn']) {
        assert.equal(text.includes(forbidden), false, `${entry} never does ${forbidden}: a reminder is one text on a result`);
      }
    }
    // The git toplevel is the ONE child, and it is the async bounded runner the edit sync already owns.
    assert.ok(code('codegraph-guard-target.js').includes("require('./codegraph-edit-sync.js')"), 'the target reuses the bounded git read');
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
    // `odd` is NOT in this list any more: it is the odd viewer's own name now. What must
    // never come back is the customize panel and the Herdr worktree panel.
    for (const gone of ['customize', 'herdr-gentle:warp']) {
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
// transcript — the card the render hook returned. A click moves the card it hit
// and NOTHING else: expansion is resolved per row from the row's own state, so
// these cases drive the registered surfaces with two cards at a time and assert
// which one repainted and which one expanded. `ctrl+o`, the host's own
// session-wide flag, still expands every card and is never written by a click.
const probeMetrics = {
  visibleWidth: (value) => [...value.replace(/\u001B\[[0-9;]*m/g, '')].length,
  truncateToWidth: (value, width, ellipsis = '') => {
    const text = value.replace(/\u001B\[[0-9;]*m/g, '');
    if (width <= 0) return '';
    if ([...text].length <= width) return value;
    return `${[...text].slice(0, Math.max(0, width - [...String(ellipsis ?? '')].length)).join('')}${String(ellipsis ?? '')}`;
  },
  wrapTextWithAnsi: (value, width) => {
    const text = value.replace(/\u001B\[[0-9;]*m/g, '');
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

const probeText = (label) => [1, 2, 3, 4, 5, 6, 7, 8].map((line) => `${label} line ${line}`).join('\n');
const probeResult = (label) => ({ content: [{ type: 'text', text: probeText(label) }], details: {} });

/** One tool row as the host drives it: one state per execution, a fresh context per render. */
function toolRow(tool, label, expanded = false) {
  const state = {};
  const counter = { invalidations: 0 };
  const build = (hostExpanded) => tool.renderResult(probeResult(label), { expanded: hostExpanded, isPartial: false }, probeTheme, {
    isPartial: false,
    expanded: hostExpanded,
    state,
    invalidate: () => { counter.invalidations += 1; },
  });
  const component = build(expanded);
  const rows = component.render(60);
  return {
    component,
    rows,
    counter,
    click: (x = 2, y = 0) => mouse(component, rows, 'click', x, y),
    press: (x = 2, y = 0) => mouse(component, rows, 'press', x, y),
    repaint: () => build(expanded).render(60),
  };
}

describe('a click expands only the card it hit', () => {
  test('one tool card expands, its sibling is untouched, and the host flag is never written', async () => {
    const { mod, tools } = await loadFromLibDir(LIB_DIR);
    try {
      mod.setWorktreeToolCardMetrics(probeMetrics);
      const clicked = toolRow(tools.get('worktree_create'), 'clicked');
      const sibling = toolRow(tools.get('worktree_list'), 'sibling');
      assert.ok(clicked.rows.length > 2 && sibling.rows.length > 2, 'both cards draw a body');

      assert.deepEqual(clicked.press(2, 0), { handled: true, render: false }, 'the press claims the card so the host retargets the click');
      assert.deepEqual(clicked.click(2, 0), { handled: true }, 'the click on the card is handled');
      assert.equal(clicked.counter.invalidations, 1, 'the click repaints the card it hit');
      assert.equal(sibling.counter.invalidations, 0, 'the sibling card is not repainted');

      assert.ok(clicked.repaint().length > clicked.rows.length, 'the clicked card is expanded');
      assert.deepEqual(sibling.repaint(), sibling.rows, 'the sibling card stays exactly as it was');
    } finally {
      mod.setWorktreeToolCardMetrics(undefined);
    }
  });

  test('the warp confirmation card expands by itself and leaves another warp card collapsed', async () => {
    const { messageRenderers } = await loadFromLibDir(LIB_DIR);
    const warp = messageRenderers.get('worktree-warp');
    const message = { customType: 'worktree-warp', content: 'session warped', details: { fromName: 'feat-one', name: 'feat-two', to: '/clone-worktrees/feat-two', branch: 'feat/two' } };
    const other = { customType: 'worktree-warp', content: 'session warped', details: { fromName: 'feat-two', name: 'feat-three', to: '/clone-worktrees/feat-three', branch: 'feat/three' } };

    const card = warp(message, {}, probeTheme);
    const rows = card.render(60);
    const sibling = warp(other, {}, probeTheme);
    const siblingRows = sibling.render(60);

    assert.deepEqual(mouse(card, rows, 'press', 3, 0), { handled: true, render: false }, 'the press claims the card');
    assert.deepEqual(mouse(card, rows, 'click', 3, 0), { handled: true }, 'the click is handled');
    const expanded = card.render(60);
    assert.ok(expanded.length > rows.length, 'the clicked warp card is expanded');
    assert.ok(expanded.some((row) => row.includes('/clone-worktrees/feat-two')), 'and shows its own path');
    assert.deepEqual(sibling.render(60), siblingRows, 'the sibling warp card is untouched');
  });

  test('no click reaches for the session-wide expansion flag', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extensions', 'odd-worktree-tools.ts'), 'utf8');
    for (const name of ['getToolsExpanded', 'setToolsExpanded']) {
      assert.equal(source.includes(name), false, `${name} is not on a click path: one click moves one card, and ctrl+o stays the global one`);
    }
  });
});

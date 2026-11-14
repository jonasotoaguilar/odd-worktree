'use strict';
// S4 commands: `/warp` and `/odd-list` are driven here through the registered
// handlers. `/issues` has its own suite (tools/issues-command.test.js), where
// the `gh` runner is injected. The warp case also proves the handoff route end
// to end: `/warp @<token>` is decoded as the queued move it carries instead of
// being read as a checkout name. (T6/S3: `worktree_warp` is not registered, so
// the token is built the way the queue builds it.)
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { LIB_DIR, stubbedSource } = require('./fixtures/load-extension.js');

const scratch = [];
function track(dir) {
  scratch.push(dir);
  return dir;
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const HOOK_BIN = path.resolve(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-cmd-hookbin-'))));

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

function makeRepo() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-cmd-repo-')));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

const notifications = [];
function makeCtx(cwd, extra = {}) {
  return {
    cwd,
    hasUI: false,
    mode: 'tui',
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: {
      notify: (text, level) => { notifications.push([level, text]); },
      ...extra,
    },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => (part && part.text) || '').join('\n');
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[^\x07\x1b]*\x07/g, '');
}

// The trimmed plain rows a mounted panel renders, so a test reads exactly what
// the human sees (a frame is padded to the width it was given).
function renderedRows(component, width = 100) {
  return component.render(width).map((line) => stripAnsi(line).trimEnd());
}

let host;
let commands;
let tools;
let mod;
before(async () => {
  process.env.GENTLE_WORKTREE_THREAD = 'thread-1';
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  const sent = [];
  const loaded = await loadExtensionWithModule({ sendUserMessage: (text, options) => { sent.push([text, options]); } });
  host = loaded.host;
  commands = loaded.commands;
  tools = loaded.tools;
  mod = loaded.mod;
  host.sent = sent;
});

// The `/warp` create front lives on the same module instance as the registered
// command, so this suite keeps the module namespace beside the registrations —
// the same stubs, lib override and fake host as the shared fixture.
// `setWarpDirtyAsker` and `executeWorktreeCreate` are that instance's own
// exported seams: how the panel's pending-changes answer and its specific-path
// selection are driven through the panel front (never through the tool).
async function loadExtensionWithModule(pi) {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-cmd-ext-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    const loadedMod = await import(pathToFileURL(copy).href);
    const registered = new Map();
    const registeredTools = new Map();
    const hooks = [];
    const fakeHost = {
      registerCommand: (name, handler) => { registered.set(name, handler); },
      registerTool: (tool) => { registeredTools.set(tool.name, tool); },
      registerMessageRenderer: () => {},
      on: (event, handler) => { hooks.push([event, handler]); },
      ...pi,
    };
    loadedMod.default(fakeHost);
    return { mod: loadedMod, commands: registered, tools: registeredTools, hooks, host: fakeHost };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The destination the ported pipeline really writes, read from the pipeline's
// own rule (<repo-parent>/<repo-name>-worktrees/<odd>) instead of remembering
// a flattened spelling.
function portedDestination(repo, odd) {
  const create = require('../lib/worktree-create.js');
  return create.worktreeDestinationPath(fs.realpathSync(repo), odd);
}

// S3/S4: the list document this package used to keep. It is gone, so every case that
// used to read it now asserts it was never written.
function sharedDocumentPath(repo) {
  return path.join(fs.realpathSync(repo), '.git', 'pi-worktrees.json');
}

// The selector's create action, then the create panel's answer, then the
// closing selector: only those three mounts are scripted.
function warpCreateUi(panelAnswer) {
  const ui = {
    mounts: 0,
    custom: async () => {
      ui.mounts += 1;
      if (ui.mounts === 1) return { create: true };
      if (ui.mounts === 2) return panelAnswer;
      return undefined;
    },
  };
  return ui;
}

describe('/warp', () => {
  test('refuses more than one name and says which form to use', async () => {
    notifications.length = 0;
    await commands.get('warp').handler('feat-x principal', makeCtx(makeRepo()));
    assert.deepEqual(notifications, [
      ['error', 'worktree warp needs exactly one name: use /warp <name> (the flattened branch slug, or principal).'],
    ]);
  });

  test('outside a repository asks for git init instead of opening the selector', async () => {
    const loose = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-cmd-loose-')));
    notifications.length = 0;
    await commands.get('warp').handler('', makeCtx(loose));
    assert.deepEqual(notifications, [['info', `not a git repository: ${loose}; run 'git init' first`]]);
  });

  test('a warp outside a session reports that it needs a session, not a crash', async () => {
    const repo = makeRepo();
    notifications.length = 0;
    await commands.get('warp').handler('feat-none', makeCtx(repo));
    assert.deepEqual(notifications, [
      ['error', 'worktree warp is only available as a session command: run /warp <name> from a Pi session'],
    ]);
  });

  test('the /warp @<token> handoff is decoded as a move, not read as a name', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute(
      'call-1',
      { branch: 'feat/warp-me', odd: 'warp-me' },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(created.isError, true, resultText(created));
    const target = created.details.path;

    // The token the queue re-dispatches: one base64url argument carrying the
    // move it validated (lib/../extensions `prepareWarpHandoff`).
    const message = `/warp @${Buffer.from(JSON.stringify({
      v: 1,
      name: 'feat-warp-me',
      target,
      from: fs.realpathSync(repo),
      branch: 'feat/warp-me',
    }), 'utf8').toString('base64url')}`;

    // The command accepts exactly that argument: the handoff is decoded (the
    // session-control refusal is the NEXT gate, so nothing about the token is
    // rejected) instead of falling through to the name path.
    notifications.length = 0;
    await commands.get('warp').handler(message.slice('/warp '.length), ctx);
    assert.deepEqual(notifications, [
      ['error', 'worktree warp is only available as a session command: run /warp <name> from a Pi session'],
    ]);
  });
});

describe('the /warp panel create front', () => {
  // Both branch states: a branch the create makes, and an existing branch it
  // adopts. The assertion asks the pipeline where it writes instead of
  // remembering the old flattened spelling.
  for (const existing of [false, true]) {
    const name = existing ? 'adopted' : 'fresh';
    const branch = `feat/${name}`;
    test(`${existing ? 'adopts an existing' : 'creates a new'} branch and reports the create without a stray notice`, async () => {
      const repo = makeRepo();
      if (existing) git(repo, ['branch', branch]);
      const target = portedDestination(repo, name);
      // S1 (warp-branch-field): the panel answers the branch it composed and the
      // ODD that names the directory, and the branch travels through UNCHANGED —
      // nothing derives it from the ODD any more.
      const ui = warpCreateUi({ ok: true, branch, odd: name });
      notifications.length = 0;
      await commands.get('warp').handler('', makeCtx(repo, { custom: ui.custom }));
      assert.ok(fs.existsSync(target), `the /warp create made no checkout (notifications: ${JSON.stringify(notifications)})`);
      assert.equal(git(target, ['rev-parse', '--abbrev-ref', 'HEAD']), branch, 'the new checkout holds the created/adopted branch');
      // The create flow closed back into the selector, so the front reported a
      // create; the click asked for none of these notices.
      assert.ok(ui.mounts >= 3, `the selector was not handed back after the create (${ui.mounts} mounts)`);
      assert.deepEqual(notifications, [], 'a clean create fires no notification it did not ask for');
      // S3/S4: the checkout's directory is the whole record — no list file exists.
      assert.equal(fs.existsSync(sharedDocumentPath(repo)), false, 'no list document is written');
    });
  }

  test('the panel’s branch is passed through, never derived from the ODD', async () => {
    const repo = makeRepo();
    const target = portedDestination(repo, 'login-ui');
    const ui = warpCreateUi({ ok: true, branch: 'fix/other-name', odd: 'login-ui' });
    notifications.length = 0;
    await commands.get('warp').handler('', makeCtx(repo, { custom: ui.custom }));
    assert.ok(fs.existsSync(target), `the create made no checkout (notifications: ${JSON.stringify(notifications)})`);
    assert.equal(git(target, ['rev-parse', '--abbrev-ref', 'HEAD']), 'fix/other-name', 'the answered branch is the git branch');
    assert.equal(path.basename(target), 'login-ui', 'the ODD is the directory, so the branch names no directory');
    assert.deepEqual(notifications, [], 'a clean create fires no notification');
  });

  // S11 (warp-branch-field): one ODD is one worktree, so a create for an ODD
  // that already owns one refuses by saying THAT — the exact two lines an agent
  // reads — and refuses before writing anything.
  test('a second create for an ODD that already has a worktree refuses with its own sentence', async () => {
    const repo = makeRepo();
    const first = await tools.get('worktree_create').execute(
      'call-1', { branch: 'feat/taken', odd: 'taken' }, undefined, undefined, makeCtx(repo),
    );
    assert.notEqual(first.isError, true, resultText(first));
    const target = first.details.path;

    const second = await tools.get('worktree_create').execute(
      'call-2', { branch: 'feat/taken-again', odd: 'taken' }, undefined, undefined, makeCtx(repo),
    );
    assert.equal(second.isError, true, 'the second create is refused');
    assert.equal(
      resultText(second),
      `odd taken already has a worktree: ${target}\nUse that worktree instead of creating another.`,
    );
    // Nothing was written: no second checkout, no branch, and the clone's one
    // document is byte-identical to what the first create left.
    assert.equal(fs.existsSync(`${target}-again`), false, 'no directory is made');
    assert.equal(git(repo, ['branch', '--list', 'feat/taken-again']), '', 'no branch is created');
    assert.equal(fs.existsSync(sharedDocumentPath(repo)), false, 'no document is written by either create');
  });

  test('a plain directory at the ODD destination keeps the core’s own refusal', async () => {
    const repo = makeRepo();
    const target = portedDestination(repo, 'occupied');
    fs.mkdirSync(target, { recursive: true });
    const out = await tools.get('worktree_create').execute(
      'call-1', { branch: 'feat/occupied', odd: 'occupied' }, undefined, undefined, makeCtx(repo),
    );
    assert.equal(out.isError, true);
    assert.equal(
      resultText(out),
      `worktree path already exists: ${fs.realpathSync(target)}\nRemove it or pass a different odd.`,
    );
  });

  test('the create panel does not offer an ODD that already has a worktree', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'odd', 'tasks'), { recursive: true });
    for (const name of ['taken', 'free']) {
      fs.writeFileSync(path.join(repo, 'odd', 'tasks', `${name}.md`), `# ${name}\n`);
    }
    git(repo, ['add', '-f', 'odd']);
    git(repo, ['commit', '-m', 'odds']);
    const created = await tools.get('worktree_create').execute(
      'call-1', { branch: 'feat/taken', odd: 'taken' }, undefined, undefined, makeCtx(repo),
    );
    assert.notEqual(created.isError, true, resultText(created));

    let panelRows = null;
    let mounts = 0;
    const custom = async (factory) => {
      mounts += 1;
      if (mounts === 1) return { create: true };
      if (mounts === 2) {
        const component = factory({ requestRender: () => {} }, null, null, () => {});
        component.handleInput('\t'); // the Odd field
        panelRows = renderedRows(component);
      }
      return undefined;
    };
    notifications.length = 0;
    await commands.get('warp').handler('', makeCtx(repo, { custom }));
    assert.ok(Array.isArray(panelRows), `the create panel never mounted (${JSON.stringify(notifications)})`);
    const text = panelRows.join('\n');
    assert.ok(!/^\s+taken$/m.test(text), `the taken ODD is not offered\n${text}`);
    assert.match(text, /^\s+free$/m, 'the free ODD is still offered');
    assert.match(text, /new odd/, 'new odd is still offered');
  });

  test('a refused panel create is the ported sentence, verbatim, and writes nothing', async () => {
    const repo = makeRepo();
    const out = await mod.executeWorktreeCreate({ branch: 'feat/login', odd: 'a/b' }, makeCtx(repo));
    assert.equal(out.isError, true);
    assert.equal(
      resultText(out),
      'invalid odd name: "a/b"\nodd must be a single path segment (letters, digits, dash, underscore, dot)',
    );
    assert.equal(fs.existsSync(portedDestination(repo, 'a/b')), false);
    assert.equal(fs.existsSync(path.join(fs.realpathSync(repo), '.git', 'pi-worktrees.json')), false, 'no document is written');
  });

  test('a panel create with no ODD is refused: the ODD names the checkout', async () => {
    const repo = makeRepo();
    const out = await mod.executeWorktreeCreate({ branch: 'feat/no-odd' }, makeCtx(repo));
    assert.equal(out.isError, true);
    assert.equal(
      resultText(out),
      'invalid odd name: undefined\nodd must be a single path segment (letters, digits, dash, underscore, dot)',
    );
    assert.equal(fs.existsSync(path.join(fs.realpathSync(repo), '.git', 'pi-worktrees.json')), false, 'no document is written');
  });

  test('"copy everything" becomes the ported boolean and prints only the ported line', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'pending.txt'), 'pending\n');
    const target = portedDestination(repo, 'all-copy');
    const out = await mod.executeWorktreeCreate({ branch: 'feat/all-copy', odd: 'all-copy', changes: 'all' }, makeCtx(repo));
    assert.notEqual(out.isError, true, resultText(out));
    const text = resultText(out);
    assert.match(text, /^copy_changes: 1 changes copied$/m);
    assert.doesNotMatch(text, /^copied:/m, 'the panel line belongs to the path mode only');
    assert.equal(fs.readFileSync(path.join(target, 'pending.txt'), 'utf8'), 'pending\n', 'the ported hook copied it once');
  });

  test('a specific path selection copies only those paths and prints its own line', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'selected.txt'), 'selected\n');
    fs.writeFileSync(path.join(repo, 'skipped.txt'), 'skipped\n');
    const target = portedDestination(repo, 'selected');
    const out = await mod.executeWorktreeCreate(
      { branch: 'feat/selected', odd: 'selected', changes: ['selected.txt'] },
      makeCtx(repo),
    );
    assert.notEqual(out.isError, true, resultText(out));
    const text = resultText(out);
    assert.match(text, /^copied: 1 file, \+1\/-0$/m);
    assert.doesNotMatch(text, /^copy_changes:/m, 'the boolean mode\u2019s line is not printed by the path mode');
    assert.equal(fs.readFileSync(path.join(target, 'selected.txt'), 'utf8'), 'selected\n');
    assert.equal(fs.existsSync(path.join(target, 'skipped.txt')), false, 'only the selected path travelled');
    // S3: nothing about the transfer is stored — there is no record to hold it.
    assert.equal(fs.existsSync(sharedDocumentPath(repo)), false, 'no document is written');
  });

  test('an unknown selected path refuses before anything is created', async () => {
    const repo = makeRepo();
    const out = await mod.executeWorktreeCreate({ branch: 'feat/unknown', odd: 'unknown', changes: ['missing.txt'] }, makeCtx(repo));
    assert.equal(out.isError, true);
    assert.match(resultText(out), /unknown changed file: "missing.txt" \(nothing was copied\) \(nothing was created\)$/);
    assert.equal(fs.existsSync(portedDestination(repo, 'unknown')), false);
  });
});

// S5 (warp-branch-field): the selector offers DESTINATIONS that exist. Each mount
// re-reads the registry AND git's live listing and offers only checkouts both
// agree on, so a checkout removed before the panel opens leaves no row and a
// stale registry row can never become a selectable checkout.
describe('/warp selector after a removal', () => {
  function mountSelector() {
    const state = { rows: null };
    const custom = async (factory) => {
      const component = factory({ requestRender: () => {} }, null, null, () => {});
      state.rows = renderedRows(component);
      return undefined;
    };
    return { custom, rows: () => state.rows };
  }

  test('a removed checkout is not a row, and a live one still is', async () => {
    const repo = makeRepo();
    for (const [odd, branch] of [['removed', 'feat/removed'], ['live', 'feat/live']]) {
      const out = await tools.get('worktree_create').execute(
        'call', { branch, odd }, undefined, undefined, makeCtx(repo),
      );
      assert.notEqual(out.isError, true, resultText(out));
    }
    // Opened while both checkouts exist: both are offered.
    const before = mountSelector();
    notifications.length = 0;
    await commands.get('warp').handler('', makeCtx(repo, { custom: before.custom }));
    const beforeText = before.rows().join('\n');
    assert.match(beforeText, /feat-live/);
    assert.match(beforeText, /feat-removed/);

    // `feat-removed` goes away exactly as the human's did: git removes the
    // checkout and the registry row stays behind.
    const target = portedDestination(repo, 'removed');
    git(repo, ['worktree', 'remove', target]);
    assert.equal(fs.existsSync(target), false, 'the checkout really is gone');

    // Opened FRESH afterwards, the removed one is not a row and never a
    // destination; the live one still is.
    const after = mountSelector();
    notifications.length = 0;
    await commands.get('warp').handler('', makeCtx(repo, { custom: after.custom }));
    const afterText = after.rows().join('\n');
    assert.ok(!afterText.includes('feat-removed'), `a removed checkout is never offered\n${afterText}`);
    assert.match(afterText, /feat-live/);
    assert.deepEqual(notifications, [], 'nothing is reported as an error');
  });
});

describe('/odd-list', () => {
  test('an empty checkout says there is nothing to read', async () => {
    const repo = makeRepo();
    notifications.length = 0;
    await commands.get('odd-list').handler('', makeCtx(repo));
    assert.deepEqual(notifications, [['info', 'No odd documents under odd/tasks/ in this checkout.']]);
  });

  test('lists odd/tasks documents through the degraded select menu', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'odd', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'odd', 'tasks', 'feature.md'), '# Feature\n');
    let offered = null;
    notifications.length = 0;
    await commands.get('odd-list').handler(
      '',
      makeCtx(repo, { select: async (_title, options) => { offered = options; return options[0]; } }),
    );
    assert.deepEqual(offered, ['feature']);
    assert.deepEqual(notifications, [['info', path.join(repo, 'odd', 'tasks', 'feature.md')]]);
  });

  test('an unknown option names the command that is valid', async () => {
    notifications.length = 0;
    await commands.get('odd-list').handler('nope', makeCtx(makeRepo()));
    assert.deepEqual(notifications, [['error', 'Unknown option "nope". Use /odd-list.']]);
  });
});

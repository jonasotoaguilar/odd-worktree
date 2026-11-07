'use strict';
// S4 commands: `/warp` and `/odd-list` are driven here through the registered
// handlers. `/issues` has its own suite (tools/issues-command.test.js), where
// the `gh` runner is injected. The warp case also proves the agent route end to
// end: `worktree_warp` queues the move as `/warp @<token>` and that exact
// argument is the handoff the command decodes.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadExtension } = require('./fixtures/load-extension.js');

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
fs.writeFileSync(path.join(HOOK_BIN, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const NO_HERDR = path.join(os.tmpdir(), 'odd-worktree-no-such-herdr-binary');

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

let host;
let commands;
let tools;
before(async () => {
  process.env.HERDR_BIN_PATH = NO_HERDR;
  process.env.GENTLE_WORKTREE_THREAD = 'thread-1';
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  const sent = [];
  const loaded = await loadExtension({ sendUserMessage: (text, options) => { sent.push([text, options]); } });
  host = loaded.host;
  commands = loaded.commands;
  tools = loaded.tools;
  host.sent = sent;
});

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

  test('the agent tool queues the move as the /warp handoff the command reads', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute(
      'call-1',
      { branch: 'feat/warp-me', changes: 'none' },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(created.isError, true, resultText(created));

    host.sent.length = 0;
    const queued = await tools.get('worktree_warp').execute(
      'call-2',
      { name: 'feat-warp-me' },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(queued.isError, true, resultText(queued));
    assert.match(resultText(queued), /^worktree warp: handoff queued/);
    assert.equal(host.sent.length, 1);
    const [message, options] = host.sent[0];
    assert.deepEqual(options, { expandPromptTemplates: true });
    assert.ok(message.startsWith('/warp @'), `the queued command is /warp (${message})`);

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
      makeCtx(repo, { select: async (title, options) => { offered = options; return options[0]; } }),
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

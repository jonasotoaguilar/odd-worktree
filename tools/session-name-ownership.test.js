'use strict';
// ODD activity does not own the Pi session name.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { BRIDGE_SLOT, loadExtension } = require('./fixtures/load-extension.js');

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis[BRIDGE_SLOT];
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A checkout this package owns — `<repo-parent>/<repo-name>-worktrees/<odd>`, the
// one path rule the registry has — with its own `odd/tasks/`.
function makeWorktree(repo, odd) {
  const worktrees = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
  fs.mkdirSync(worktrees);
  scratch.push(worktrees);
  const dir = path.join(worktrees, odd);
  git(repo, ['worktree', 'add', '-q', dir, '-b', `feat/${odd}`]);
  fs.mkdirSync(path.join(dir, 'odd', 'tasks'), { recursive: true });
  return dir;
}

// A repository whose principal checkout IS the ODD's home: one commit, `odd/tasks/`
// present, nothing registered.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-name-repo-'));
  scratch.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, 'odd', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'odd', 'tasks', 'PROMPT.txt'), 'place\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'odd/tasks/PROMPT.txt\n');
  git(dir, ['add', '.gitignore']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function makeHost() {
  const state = { name: '', entries: [], nameWrites: [] };
  return {
    state,
    getSessionName() {
      return state.name;
    },
    setSessionName(next) {
      state.nameWrites.push(next);
      state.name = next;
    },
  };
}

function contextFor(host, cwd) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => 'session-wiring',
      getEntries: () => host.state.entries.slice(),
    },
  };
}

// Every `tool_call` handler, in registration order, exactly as the host runs them.
function fireToolCall(extension, event, ctx) {
  const answers = [];
  for (const [name, handler] of extension.hooks) {
    if (name !== 'tool_call') continue;
    answers.push(handler(event, ctx));
  }
  return answers;
}

test('ODD task writes and edits leave an unnamed Pi session alone', async () => {
  const repo = makeRepo();
  const worktree = makeWorktree(repo, 'feature');
  const host = makeHost();
  const extension = await loadExtension(host);
  const ctx = contextFor(host, repo);
  fireToolCall(extension, { toolName: 'write', arguments: { path: 'odd/tasks/first.md' } }, ctx);
  const nameAfterWrite = host.state.name;
  fireToolCall(extension, {
    toolName: 'edit', arguments: { path: path.join(worktree, 'odd/tasks/second.md') },
  }, ctx);
  assert.deepEqual([nameAfterWrite, host.state.name, host.state.nameWrites], ['', '', []]);
});

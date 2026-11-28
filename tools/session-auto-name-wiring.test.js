'use strict';
// Where the session is named FROM, through the extension's own wiring.
//
// The rule (the user's): an ODD write or edit renames the session to that ODD,
// wherever it lands. A worktree was already a naming source; the PRINCIPAL checkout
// was not — the naming observer resolved a registry row and returned early for
// anything else, so writing `odd/tasks/<name>.md` from the repository itself renamed
// nothing. `odd/` is the one path the write guard leaves alone in the primary
// checkout, which is exactly the case this closes.
//
// What is asserted here, through the fake host only (the events the host really sends):
// - A `tool_call` writing `odd/tasks/prompt-card-fix.md` from the PRINCIPAL checkout
//   renames the session to `Prompt card fix`.
// - The name comes from the document's own name, so the prose inside it is irrelevant
//   and the file need not exist yet.
// - A write anywhere else (`docs/`, a worktree-shaped path outside the repository)
//   renames nothing.
// - A human's name is never overwritten.
//
// A real repository in the OS temp directory, because the naming observer asks git
// which checkout the call happened in; nothing else is faked.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { SHELL_SLOT, loadExtension } = require('./fixtures/load-extension.js');

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis[SHELL_SLOT];
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

// The host double: the session-name accessors the naming path requires. The name
// lives in a holder the test keeps its own reference to, because the loader spreads
// this object into the host it hands the extension (a method mutating `this` would
// land on that copy and the assertion would read a stale value).
function makeHost() {
  const state = { name: '', entries: [] };
  return {
    state,
    getSessionName() {
      return state.name;
    },
    setSessionName(next) {
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

describe('naming from the principal checkout', () => {
  test('a write on odd/tasks/<name>.md renames the session after the ODD', async () => {
    const repo = makeRepo();
    const host = makeHost();
    const extension = await loadExtension(host);
    fireToolCall(
      extension,
      { toolName: 'write', arguments: { path: 'odd/tasks/prompt-card-fix.md' } },
      contextFor(host, repo),
    );
    assert.equal(host.state.name, 'Prompt card fix');
  });

  test('an edit renames exactly like a write', async () => {
    const repo = makeRepo();
    const host = makeHost();
    const extension = await loadExtension(host);
    fireToolCall(
      extension,
      { toolName: 'edit', arguments: { path: 'odd/tasks/warp-odd-picker.md' } },
      contextFor(host, repo),
    );
    assert.equal(host.state.name, 'Warp odd picker');
  });

  test('a second ODD written from the same checkout renames again', async () => {
    const repo = makeRepo();
    const host = makeHost();
    const extension = await loadExtension(host);
    const first = contextFor(host, repo);
    fireToolCall(extension, { toolName: 'write', arguments: { path: 'odd/tasks/prompt-card-fix.md' } }, first);
    assert.equal(host.state.name, 'Prompt card fix');
    fireToolCall(extension, { toolName: 'write', arguments: { path: 'odd/tasks/prs-panel.md' } }, first);
    assert.equal(host.state.name, 'Prs panel');
  });

  test('a write outside odd/tasks renames nothing', async () => {
    const repo = makeRepo();
    const host = makeHost();
    const extension = await loadExtension(host);
    fireToolCall(extension, { toolName: 'write', arguments: { path: 'docs/reference.md' } }, contextFor(host, repo));
    assert.equal(host.state.name, '');
  });

  test('a read of an ODD renames nothing', async () => {
    const repo = makeRepo();
    const host = makeHost();
    const extension = await loadExtension(host);
    fireToolCall(extension, { toolName: 'read', arguments: { path: 'odd/tasks/prompt-card-fix.md' } }, contextFor(host, repo));
    assert.equal(host.state.name, '');
  });

  test('a human name survives an ODD write', async () => {
    const repo = makeRepo();
    const host = makeHost();
    host.state.name = 'Mi sesión de investigación';
    const extension = await loadExtension(host);
    fireToolCall(
      extension,
      { toolName: 'write', arguments: { path: 'odd/tasks/prompt-card-fix.md' } },
      contextFor(host, repo),
    );
    assert.equal(host.state.name, 'Mi sesión de investigación');
  });
});

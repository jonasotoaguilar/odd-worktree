'use strict';
// S1/S2: no creation path reaches a Herdr binary.
//
// The package no longer resolves or builds Herdr argv at all, so this suite pins
// the claim two ways: a `herdr` sentinel FIRST on PATH records any argv it is
// given (an empty log is the assertion), and a source scan proves no file
// outside the git seam builds Herdr argv or resolves the binary. Both creation
// fronts are exercised because they share one creation helper.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadExtension, SRC, LIB_DIR } = require('./fixtures/load-extension.js');

const savedEnv = { ...process.env };
const scratch = [];
const track = (entry) => { scratch.push(entry); return entry; };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of scratch) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

const BIN = track(fs.mkdtempSync(path.join(os.tmpdir(), 'no-herdr-bin-')));
const HERDR_LOG = path.join(BIN, 'calls.log');
fs.writeFileSync(
  path.join(BIN, 'herdr'),
  '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HERDR_LOG"\nexit 1\n',
  { mode: 0o755 },
);
fs.writeFileSync(path.join(BIN, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

function herdrCalls() {
  try {
    return fs.readFileSync(HERDR_LOG, 'utf8').trim();
  } catch {
    return '';
  }
}
const resetHerdr = () => fs.writeFileSync(HERDR_LOG, '');

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

function makeRepo() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'no-herdr-repo-')));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'no-herdr@example.test']);
  git(dir, ['config', 'user.name', 'No Herdr']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return fs.realpathSync(dir);
}

const resultText = (result) => (result.content || []).map((part) => (part && part.text) || '').join('\n');

function ctxFor(repo, notes, ui) {
  return {
    cwd: repo,
    hasUI: true,
    mode: 'tui',
    sessionManager: { getSessionId: () => 'no-herdr-session' },
    ui: { confirm: async () => true, notify: (text, level) => notes.push([level, text]), ...(ui || {}) },
  };
}

// `/warp` create: the selector's create action, the create panel's answer, then
// the closing selector. Only those answers are scripted.
function warpCreateUi(panelAnswer) {
  let call = 0;
  return {
    custom: async () => {
      call += 1;
      if (call === 1) return { create: true };
      if (call === 2) return panelAnswer;
      return undefined;
    },
  };
}

let tools;
let commands;
before(async () => {
  process.env.PATH = `${BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  process.env.GENTLE_WORKTREE_THREAD = 'no-herdr-session';
  ({ tools, commands } = await loadExtension({}));
});

describe('no creation path invokes Herdr', () => {
  for (const existing of [false, true]) {
    const kind = existing ? 'an existing' : 'a new';

    test(`worktree_create never invokes Herdr for ${kind} branch`, async () => {
      resetHerdr();
      const repo = makeRepo();
      const branch = existing ? 'feat/adopted' : 'feat/fresh';
      if (existing) git(repo, ['branch', branch]);
      const result = await tools.get('worktree_create').execute(
        'no-herdr-tool',
        { branch, changes: 'none' },
        undefined,
        undefined,
        ctxFor(repo, []),
      );
      assert.notEqual(result.isError, true, resultText(result));
      assert.equal(result.details.branchCreated, !existing);
      assert.equal(herdrCalls(), '', `Herdr was invoked: ${herdrCalls()}`);
      assert.doesNotMatch(resultText(result), /herdr (workspace|association)/i, 'no Herdr workspace is reported');
    });

    test(`/warp create never invokes Herdr for ${kind} branch`, async () => {
      resetHerdr();
      const repo = makeRepo();
      const name = existing ? 'adopted' : 'fresh';
      if (existing) git(repo, ['branch', `feat/${name}`]);
      const notes = [];
      await commands.get('warp').handler('', ctxFor(repo, notes, warpCreateUi({ ok: true, type: 'feat', name })));
      const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, `feat-${name}`);
      assert.ok(fs.existsSync(target), `the /warp create made no checkout (notifications: ${JSON.stringify(notes)})`);
      assert.equal(herdrCalls(), '', `Herdr was invoked: ${herdrCalls()}`);
      for (const [, text] of notes) assert.doesNotMatch(text, /herdr (workspace|association)/i, `Herdr reported: ${text}`);
    });
  }

  test('a refused create writes nothing and never invokes Herdr', async () => {
    resetHerdr();
    const repo = makeRepo();
    const before = git(repo, ['branch', '--format=%(refname:short)']);
    const result = await tools.get('worktree_create').execute(
      'no-herdr-bad',
      { branch: 'bad..name', changes: 'none' },
      undefined,
      undefined,
      ctxFor(repo, []),
    );
    assert.equal(result.isError, true);
    assert.match(resultText(result), /^invalid branch name/);
    assert.equal(git(repo, ['branch', '--format=%(refname:short)']), before);
    assert.equal(herdrCalls(), '', `Herdr was invoked: ${herdrCalls()}`);
  });

  // S1 is an AUDIT claim: no source file outside the git seam reaches a Herdr
  // binary. Pinned as text so a reintroduced call cannot hide in a helper.
  test('no source file outside lib/worktree-git.js calls a Herdr binary', () => {
    const files = [
      SRC,
      ...fs.readdirSync(LIB_DIR).filter((name) => name.endsWith('.js')).map((name) => path.join(LIB_DIR, name)),
    ].filter((file) => !file.endsWith(`${path.sep}worktree-git.js`));
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /herdrArgv\s*\(/, `${file} builds Herdr argv`);
      assert.doesNotMatch(source, /resolveHerdrBinary\s*\(/, `${file} resolves the Herdr binary`);
    }
  });
});

'use strict';
// T1, T2, T5 and T6 (S1–S11): the two `bash` guards and the reason each prints.
//
// The guarded forms are one table: every allowed and refused spelling from the
// spec, through the module's one entry point and, for the extension half, through
// the `tool_call` handler the host actually receives. The git answers the module
// needs are injected in the module table (no child is spawned for a decision), and
// the extension half builds throwaway repositories under the system temp directory
// because the wiring is what resolves git — every one of them is removed in teardown.
//
// Three facts are the seams, and each call counts its reads, so "read only when the
// rule needs it" is observable: which checkout a cwd is (`repoIdentity`), the
// repository's default branch (`defaultBranch`) and the branch that checkout is on
// RIGHT NOW (`currentBranch`). S11 walks the command's own `cd`s, so a row may also
// move the effective cwd before the switch it judges.
//
// The guarded commands are INPUT TEXT only: the guard reads the string and never
// runs it, so the rows below are passed to the decision and to the handler, and the
// only children this file spawns are the `git init`/`git worktree add` of its own
// fixtures. Public behavior only: what the handler returns.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decideBashGuard } = require('../lib/worktree-guard.js');
const { loadExtension } = require('./fixtures/load-extension.js');

// The two refusals of S10, written out: a reworded sentence fails here.
const WORKTREE_ADD_REFUSAL = '`git worktree add` did not run: create the ODD\'s checkout with `worktree_create`.';
const BRANCH_SWITCH_REFUSAL = 'The branch switch did not run: the principal checkout stays on its default branch. Create the ODD\'s checkout with `worktree_create`.';

const REFUSALS = [WORKTREE_ADD_REFUSAL, BRANCH_SWITCH_REFUSAL];

// The two checkouts one repository has: the principal (its root IS the common dir's
// parent) and a linked worktree (it shares the principal's common dir).
const PRINCIPAL = { root: '/repo', commonDir: '/repo/.git' };
const LINKED = { root: '/elsewhere/repo-worktrees/odd-a', commonDir: '/repo/.git' };

// A SHA-looking ref, for the detached-checkout rows. Nothing runs it: the guard only
// reads it as text, so it is spelled through one constant.
const SHA_REF = '4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a';

// The paths a `git checkout <path>` restore may name: the seam answers for these
// and for nothing else, so `feat/x` is a branch and `src/app.ts` a file.
const EXISTING_PATHS = ['README.md', 'src/app.ts', './src', 'LICENSE', '.'];

// S11: which checkout a cwd is, resolved by path equality, so a command's own `cd`
// is observable: `/repo` is the principal, the worktrees directory entry is linked,
// and anything else is not a checkout at all.
function identityByCwd(cwd) {
  if (typeof cwd !== 'string') return undefined;
  if (cwd === PRINCIPAL.root) return PRINCIPAL;
  if (cwd === LINKED.root) return LINKED;
  return undefined;
}

// A harness over the module's one entry point: every seam is a fake, and each call
// counts its reads, so "read only when the rule needs it" is observable.
function harness(options = {}) {
  const reads = { identity: 0, defaultBranch: 0, currentBranch: 0 };
  const identity = 'identity' in options ? options.identity : PRINCIPAL;
  const defaultBranch = 'defaultBranch' in options ? options.defaultBranch : 'main';
  const currentBranch = 'currentBranch' in options ? options.currentBranch : 'main';
  const run = (command, callOptions = {}) => decideBashGuard({
    toolName: 'toolName' in callOptions ? callOptions.toolName : 'bash',
    command,
    cwd: 'cwd' in callOptions ? callOptions.cwd : '/repo',
    repoIdentity: (cwd) => {
      reads.identity += 1;
      if (identity instanceof Error) throw identity;
      return typeof identity === 'function' ? identity(cwd) : identity;
    },
    pathExists: (cwd, value) => ('paths' in options ? options.paths : EXISTING_PATHS).includes(value),
    defaultBranch: () => {
      reads.defaultBranch += 1;
      if (defaultBranch instanceof Error) throw defaultBranch;
      return defaultBranch;
    },
    currentBranch: (root) => {
      reads.currentBranch += 1;
      if (currentBranch instanceof Error) throw currentBranch;
      return typeof currentBranch === 'function' ? currentBranch(root) : currentBranch;
    },
  });
  return { run, reads };
}

// ---- S10: the refusals themselves ----

describe('the refusals are one reminder each (S10)', () => {
  test('each one says its command did not run and names the tool that replaces it', () => {
    for (const [sentence, tool] of [
      [WORKTREE_ADD_REFUSAL, '`worktree_create`'],
      [BRANCH_SWITCH_REFUSAL, '`worktree_create`'],
    ]) {
      assert.equal(sentence.includes('!'), false, `no exclamation: ${sentence}`);
      assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(sentence), false, `no emoji: ${sentence}`);
      assert.match(sentence, /did not run:/, `says the command did not run: ${sentence}`);
      assert.ok(sentence.endsWith('.'), `ends with a period: ${sentence}`);
      assert.ok(sentence.includes(tool), `names ${tool}: ${sentence}`);
    }
  });

  test('no refusal sequences two tools or restates the workflow', () => {
    for (const sentence of REFUSALS) {
      const named = sentence.match(/`worktree_(?:list|create)`/g) || [];
      assert.equal(named.length, 1, `exactly one tool is named: ${sentence}`);
    }
  });
});

// ---- S1: any cwd, text only ----

const WORKTREE_ADD_COMMANDS = [
  'git worktree add ../odd-a',
  'git -C /repo worktree add ../odd-a',
  'git --no-pager worktree add ../odd-a',
  'git -c core.pager=cat worktree add ../odd-a',
  'git worktree add ../odd-a -b feat/odd-a',
  'cd /repo && git worktree add ../odd-a',
  'git status || git worktree add ../odd-a',
  'git status; git worktree add ../odd-a',
  'git status | git worktree add ../odd-a',
  'git status & git worktree add ../odd-a',
  'git status\ngit worktree add ../odd-a',
  'echo $(git worktree add ../odd-a)',
  'echo `git worktree add ../odd-a`',
  'echo "$(git -C /repo worktree add ../odd-a)"',
  'sudo git worktree add ../odd-a',
  'git worktree add "$(pwd)/../odd-a"',
];

const WORKTREE_LIST_COMMANDS = [
  'git worktree list',
  'git worktree list --porcelain',
  'git -C /repo worktree list --porcelain',
  'git --no-pager worktree list',
  'git status && git worktree list --porcelain',
  'git worktree list | head -20',
  'echo $(git worktree list --porcelain)',
];

describe('S1: the create command is refused in every cwd', () => {
  test('the add sequence is refused with the create refusal', () => {
    for (const command of WORKTREE_ADD_COMMANDS) {
      for (const [label, options] of [
        ['the principal checkout', { identity: PRINCIPAL }],
        ['a linked worktree', { identity: LINKED }],
        ['no repository at all', { identity: new Error('not a git repository') }],
      ]) {
        const { run } = harness(options);
        assert.deepEqual(run(command), { block: true, reason: WORKTREE_ADD_REFUSAL }, `${command} in ${label}`);
      }
    }
  });

  test('listing worktrees with Git is never refused, in any cwd', () => {
    for (const command of WORKTREE_LIST_COMMANDS) {
      for (const options of [{ identity: PRINCIPAL }, { identity: LINKED }, { identity: new Error('not a git repository') }]) {
        const { run } = harness(options);
        assert.deepEqual(run(command), { block: false }, command);
      }
    }
  });

  test('a script, alias or make target that would create one is not inspected', () => {
    for (const command of ['bash scripts/create-worktree.sh', 'make create-worktree', 'npm run worktree:add', 'git config alias.wt "worktree add"']) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: false }, command);
    }
  });
});

// ---- S3: creating a branch is allowed everywhere (L10) ----

const BRANCH_COMMANDS = [
  'git branch odd-a',
  'git branch odd-a main',
  'git branch -f odd-a',
  'git branch -f odd-a main',
  'git branch -t odd-a origin/odd-a',
  'git branch --track odd-a origin/odd-a',
  'git branch -m odd-a',
  'git branch -m odd-a odd-b',
  'git branch -c odd-a odd-b',
  'git branch -d odd-a',
  'git branch -D odd-a',
  'git branch --list odd',
  'git branch',
  'git branch -a',
  'git branch -v',
  'git status && git branch odd-a',
  'git -C /repo branch odd-a',
  'cd /repo && git branch odd-a',
];

describe('S3: creating a branch passes, in the principal checkout and everywhere else', () => {
  test('every `git branch` form passes and reads no branch state', () => {
    for (const command of BRANCH_COMMANDS) {
      const { run, reads } = harness();
      assert.deepEqual(run(command), { block: false }, command);
      assert.deepEqual(reads, { identity: 0, defaultBranch: 0, currentBranch: 0 }, `${command} reads nothing`);
    }
  });

  test('the same command passes inside a linked worktree', () => {
    for (const command of BRANCH_COMMANDS) {
      const { run } = harness({ identity: LINKED });
      assert.deepEqual(run(command, { cwd: LINKED.root }), { block: false }, command);
    }
  });
});

// ---- S4 and S5: leaving the branch the principal checkout is on ----

describe('S4: leaving the default branch of the principal checkout is refused', () => {
  test('another branch, the previous branch and a detached checkout are refused', () => {
    for (const command of [
      'git checkout develop',
      'git switch develop',
      'git checkout -',
      'git switch -',
      `git checkout ${SHA_REF}`,
      `git checkout ${SHA_REF.slice(0, 7)}`,
      'git checkout --detach main',
      'git switch --detach',
      'git checkout HEAD~2',
      'git status; git checkout develop',
      'git -C /repo switch develop',
    ]) {
      const { run, reads } = harness();
      assert.deepEqual(run(command), { block: true, reason: BRANCH_SWITCH_REFUSAL }, command);
      assert.equal(reads.defaultBranch, 1, `${command} reads the default branch lazily, once`);
      assert.equal(reads.currentBranch, 1, `${command} reads the current branch lazily, once`);
    }
  });

  test('coming back to the branch it is on, and asking for nothing, pass', () => {
    for (const command of ['git checkout main', 'git switch main']) {
      const { run, reads } = harness();
      assert.deepEqual(run(command), { block: false }, command);
      assert.equal(reads.currentBranch, 1, `${command} still asks which branch that is`);
    }
    for (const command of ['git checkout', 'git switch']) {
      const { run, reads } = harness();
      assert.deepEqual(run(command), { block: false }, command);
      assert.deepEqual(reads, { identity: 0, defaultBranch: 0, currentBranch: 0 }, `${command} judges no switch`);
    }
  });

  test('a switch when the checkout is on any other branch passes', () => {
    for (const command of [
      'git checkout develop',
      'git switch develop',
      'git checkout -',
      'git switch --detach',
      'git checkout -b feat/y',
    ]) {
      const { run, reads } = harness({ currentBranch: 'feat/x' });
      assert.deepEqual(run(command), { block: false }, command);
      assert.equal(reads.defaultBranch, 1, `${command} resolves the default branch`);
      assert.equal(reads.currentBranch, 1, `${command} reads the current branch once`);
    }
  });

  test('a detached HEAD, an unreadable branch and a missing seam block nothing', () => {
    for (const currentBranch of [undefined, '', new Error('detached HEAD')]) {
      const { run } = harness({ currentBranch });
      assert.deepEqual(run('git switch develop'), { block: false }, String(currentBranch));
      assert.deepEqual(run('git switch --detach'), { block: false }, String(currentBranch));
    }
  });

  test('creating a branch and switching to it leaves the branch too', () => {
    for (const command of [
      'git checkout -b feat/x',
      'git checkout -B feat/x',
      'git checkout -bx',
      'git checkout --orphan odd-a',
      'git switch -c feat/x',
      'git switch -C feat/x',
      'git switch --create feat/x',
      'git switch --force-create feat/x',
      'git switch --create=feat/x',
      'git switch --force-create=feat/x',
      'git checkout --orphan=odd-a',
      'git checkout -q -b feat/x',
      'git status && git switch -c feat/x',
      'git -C /repo switch -c feat/x',
    ]) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: true, reason: BRANCH_SWITCH_REFUSAL }, command);
    }
  });

  test('a switch that lands on a named branch is the branch the next segment leaves', () => {
    // The command moves the checkout from `dev` to `main` and then leaves `main`.
    const { run, reads } = harness({ currentBranch: 'dev' });
    assert.deepEqual(run('git switch main && git switch develop'), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.equal(reads.currentBranch, 1, 'the branch the command moved to is the one the next segment leaves');
    assert.deepEqual(run('git switch main && git switch main'), { block: false });
  });

  test('the same command is allowed inside a linked worktree, reading no current branch', () => {
    for (const command of ['git checkout develop', 'git switch develop', 'git checkout -', 'git checkout --detach main', 'git switch -c feat/x']) {
      const { run, reads } = harness({ identity: LINKED });
      assert.deepEqual(run(command, { cwd: LINKED.root }), { block: false }, command);
      assert.equal(reads.currentBranch, 0, `${command} reads no principal's current branch`);
    }
  });
});

describe('S5: the default branch is the repository\'s own', () => {
  test('a master repository allows master and refuses another branch', () => {
    const { run } = harness({ defaultBranch: 'master', currentBranch: 'master' });
    assert.deepEqual(run('git checkout master'), { block: false });
    assert.deepEqual(run('git switch master'), { block: false });
    assert.deepEqual(run('git checkout develop'), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.deepEqual(run('git checkout main'), { block: true, reason: BRANCH_SWITCH_REFUSAL });
  });

  test('a trunk repository allows trunk and refuses main, so nothing is allowlisted', () => {
    const { run } = harness({ defaultBranch: 'trunk', currentBranch: 'trunk' });
    assert.deepEqual(run('git checkout trunk'), { block: false });
    assert.deepEqual(run('git switch trunk'), { block: false });
    assert.deepEqual(run('git checkout main'), { block: true, reason: BRANCH_SWITCH_REFUSAL });
  });

  test('with no resolvable default branch a switch is not refused and no branch is read', () => {
    for (const defaultBranch of [undefined, '', new Error('git config failed')]) {
      const { run, reads } = harness({ defaultBranch });
      assert.deepEqual(run('git checkout develop'), { block: false }, String(defaultBranch));
      assert.equal(reads.currentBranch, 0, `${String(defaultBranch)}: no default branch, nothing to leave`);
    }
  });
});

// ---- S11: the command's own `cd` decides which checkout is judged ----

describe('S11: a cd moves the checkout the switch is judged in', () => {
  test('a cd into a linked worktree makes the switch nothing', () => {
    for (const command of [
      `cd ${LINKED.root} && git switch develop`,
      `cd ${LINKED.root}; git checkout -`,
      `cd ${LINKED.root} && git checkout -b feat/x`,
      `cd ${PRINCIPAL.root} && cd ${LINKED.root} && git switch --detach`,
    ]) {
      const { run } = harness({ identity: identityByCwd });
      assert.deepEqual(run(command), { block: false }, command);
    }
  });

  test('a cd into the principal blocks, whatever the tool call\'s own cwd is', () => {
    for (const command of [
      `cd ${PRINCIPAL.root} && git switch develop`,
      `cd ${LINKED.root} && cd ${PRINCIPAL.root} && git switch develop`,
    ]) {
      const { run } = harness({ identity: identityByCwd });
      assert.deepEqual(run(command, { cwd: LINKED.root }), { block: true, reason: BRANCH_SWITCH_REFUSAL }, command);
    }
  });

  test('a relative cd resolves against the cwd in force before it', () => {
    const { run } = harness({ identity: identityByCwd });
    assert.deepEqual(run('cd repo && git switch develop', { cwd: '/' }), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.deepEqual(run('cd odd-a && git switch develop', { cwd: '/elsewhere/repo-worktrees' }), { block: false });
  });

  test('git -C names the checkout that segment is judged in', () => {
    const { run } = harness({ identity: identityByCwd });
    // Typed in the principal, run in a linked worktree: that checkout is judged, and it
    // leaves nothing (S8 forbids the false block the principal's own branch would give).
    assert.deepEqual(run(`git -C ${LINKED.root} switch develop`), { block: false });
    assert.deepEqual(run(`git -C ${LINKED.root} checkout -b feat/x`), { block: false });
    // Typed in a linked worktree, run in the principal: the principal is judged.
    assert.deepEqual(run(`git -C ${PRINCIPAL.root} switch develop`, { cwd: LINKED.root }), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    // `-C` may repeat, and the last one wins, as with git.
    assert.deepEqual(run(`git -C ${LINKED.root} -C ${PRINCIPAL.root} switch develop`, { cwd: LINKED.root }), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.deepEqual(run(`git -C ${PRINCIPAL.root} -C ${LINKED.root} switch develop`), { block: false });
    // A `-C` target is a literal path, resolved against the cwd in force for the segment.
    assert.deepEqual(run('git -C repo switch develop', { cwd: '/' }), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.deepEqual(run('git -C odd-a switch develop', { cwd: '/elsewhere/repo-worktrees' }), { block: false });
    for (const command of ['git -C $WORKTREE switch develop', 'git -C ~ switch develop']) {
      assert.deepEqual(run(command), { block: false }, command);
    }
  });

  test('a cd inside a quoted argument is text, not a directory change', () => {
    const { run } = harness({ identity: identityByCwd });
    // This shell never runs a quoted argument, so its `cd` moves nothing (S11).
    assert.deepEqual(run(`echo 'cd ${LINKED.root}'; git switch develop`), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.deepEqual(run(`git commit -m "cd ${LINKED.root}"; git switch develop`), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.deepEqual(run(`echo "cd ${PRINCIPAL.root}"; git switch develop`, { cwd: LINKED.root }), { block: false });
    // A shell script argument, a substitution and a backtick span ARE run, so they move it.
    for (const command of [
      `echo $(cd ${LINKED.root}) && git switch develop`,
      `echo \`cd ${LINKED.root}\` && git switch develop`,
      `bash -c 'cd ${LINKED.root}'; git switch develop`,
    ]) {
      assert.deepEqual(run(command), { block: false }, command);
    }
  });

  test('a cd to a checkout that is not this repository blocks nothing', () => {
    const { run } = harness({ identity: identityByCwd });
    assert.deepEqual(run('cd /tmp && git switch develop'), { block: false });
  });

  test('an unknown cd target blocks nothing of S4 (S8)', () => {
    for (const command of [
      'cd $HOME && git switch develop',
      'cd $WORKTREE && git checkout -b feat/x',
      'cd ~ && git switch develop',
      'cd - && git switch develop',
      'cd && git switch develop',
      'cd ./* && git switch develop',
      'cd `pwd` && git switch develop',
    ]) {
      const { run } = harness({ identity: identityByCwd });
      assert.deepEqual(run(command), { block: false }, command);
    }
  });

  test('S1 stays any-cwd: a cd never shelters a worktree command', () => {
    const { run } = harness({ identity: identityByCwd });
    assert.deepEqual(run(`cd ${LINKED.root} && git worktree add ../odd-b`), { block: true, reason: WORKTREE_ADD_REFUSAL });
    assert.deepEqual(run('cd $HOME && git worktree list'), { block: false });
  });
});

// ---- S6: everything else passes untouched ----

describe('S4: a slash-named ref is a branch, not a path', () => {
  test('checkout and switch refuse a slash-named or remote ref that is not a file', () => {
    for (const command of [
      'git checkout feat/x',
      'git switch feat/x',
      'git checkout origin/main',
      'git switch origin/main',
      'git checkout release/1.2',
      'git switch release/1.2',
      'git switch README.md',
    ]) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: true, reason: BRANCH_SWITCH_REFUSAL }, command);
    }
  });

  test('a checkout of an existing file is a restore, and the default branch stays allowed', () => {
    for (const command of ['git checkout README.md', 'git checkout src/app.ts', 'git checkout -- feat/x']) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: false }, command);
    }
    const { run } = harness({ defaultBranch: 'trunk' });
    assert.deepEqual(run('git checkout trunk'), { block: false });
    assert.deepEqual(run('git switch trunk'), { block: false });
  });

  test('without the path seam every argument is a ref', () => {
    const { run } = harness({ paths: [] });
    assert.deepEqual(run('git checkout src/app.ts'), { block: true, reason: BRANCH_SWITCH_REFUSAL });
  });
});

describe('S1: the sequence is found wherever the text puts it', () => {
  test('a subshell, a quoted shell command and a line continuation still refuse', () => {
    for (const verb of ['add ../odd-probe']) {
      const reason = WORKTREE_ADD_REFUSAL;
      for (const command of [
        `(git worktree ${verb})`,
        `bash -c 'git worktree ${verb}'`,
        `sh -c "git worktree ${verb}"`,
        `git \\\n worktree ${verb}`,
        `/usr/bin/git worktree ${verb}`,
        `env git worktree ${verb}`,
        `echo x | xargs git worktree ${verb}`,
      ]) {
        const { run } = harness();
        assert.deepEqual(run(command, { cwd: '/anywhere' }), { block: true, reason }, command);
      }
    }
  });
});

describe('S3 and S4: attached flags, compounds and restores from a ref', () => {
  test('an attached branch name and a bare detach are what they are', () => {
    for (const [command, reason] of [
      ['git checkout -bx', BRANCH_SWITCH_REFUSAL],
      ['git checkout -Bx', BRANCH_SWITCH_REFUSAL],
      ['git switch -cx', BRANCH_SWITCH_REFUSAL],
      ['git switch --create x', BRANCH_SWITCH_REFUSAL],
      ['git checkout --detach', BRANCH_SWITCH_REFUSAL],
    ]) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: true, reason }, command);
    }
    for (const command of ['git branch -f x', 'git branch --track x origin/x', 'git branch -D x']) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: false }, command);
    }
  });

  test('an allowed switch never hides a later forbidden one', () => {
    for (const command of [
      'git checkout main && git checkout develop',
      'git switch main; git switch feat/x',
      'git checkout main\ngit checkout develop',
    ]) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: true, reason: BRANCH_SWITCH_REFUSAL }, command);
    }
  });

  test('a restore from a ref, or of an extensionless file, switches nothing', () => {
    for (const command of [
      'git checkout HEAD -- .',
      'git checkout develop -- src/app.ts',
      'git checkout main -- README.md',
      'git checkout LICENSE',
      'git checkout .',
      'git branch -c a b',
      'git branch -m a b',
      'git branch --set-upstream-to=origin/main',
    ]) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: false }, command);
    }
  });
});

describe('S6: everything else passes', () => {
  test('inspection, restores and the other worktree verbs', () => {
    for (const command of [
      'git status',
      'git log --oneline -5',
      'git diff',
      'git add .',
      'git commit -m "x"',
      'git worktree remove ../odd-a',
      'git worktree prune',
      'git worktree move ../odd-a ../odd-b',
      'git restore .',
      'git restore --staged README.md',
      'git checkout -- README.md',
      'git checkout README.md',
      'git checkout src/app.ts',
      'git checkout ./src',
    ]) {
      const { run } = harness();
      assert.deepEqual(run(command), { block: false }, command);
    }
  });

  test('every non-bash tool call passes, whatever its input', () => {
    for (const toolName of ['read', 'write', 'edit', 'grep', 'find', 'ls', 'worktree_create', 'worktree_list']) {
      const { run } = harness();
      assert.deepEqual(run('git worktree add ../odd-a', { toolName }), { block: false }, toolName);
      assert.deepEqual(run('git checkout -b feat/odd-a', { toolName }), { block: false }, toolName);
    }
  });

  test('a command that is not text decides nothing', () => {
    const { run } = harness();
    for (const command of [undefined, null, '', 42, {}]) {
      assert.deepEqual(run(command), { block: false }, String(command));
    }
  });
});

// ---- S8: honest failure, never a false block ----

describe('S8: an unreadable repository fails open, and nothing throws', () => {
  test('without an identity only S1 applies', () => {
    for (const identity of [new Error('not a git repository'), undefined, null, {}, { root: '/repo' }]) {
      const { run } = harness({ identity });
      assert.deepEqual(run('git checkout -b feat/odd-a'), { block: false }, String(identity));
      assert.deepEqual(run('git checkout develop'), { block: false }, String(identity));
      assert.deepEqual(run('git worktree add ../odd-a'), { block: true, reason: WORKTREE_ADD_REFUSAL }, String(identity));
      assert.deepEqual(run('git worktree list'), { block: false }, String(identity));
    }
  });

  test('a cwd that is not a checkout decides nothing about branches', () => {
    const { run } = harness();
    for (const cwd of [undefined, null, '', 0]) {
      assert.deepEqual(run('git checkout develop', { cwd }), { block: false }, String(cwd));
    }
  });

  test('a seam that throws never escapes', () => {
    const { run } = harness({ identity: new Error('boom'), defaultBranch: new Error('boom') });
    assert.deepEqual(run('git checkout -b feat/odd-a'), { block: false });
    assert.deepEqual(run('git status'), { block: false });
  });

  test('an allowed call reads no more than it needs', () => {
    for (const command of ['git status', 'git worktree remove ../odd-a', 'git branch feat/x']) {
      const { run, reads } = harness();
      assert.deepEqual(run(command), { block: false }, command);
      assert.deepEqual(reads, { identity: 0, defaultBranch: 0, currentBranch: 0 }, `${command} reads nothing`);
    }
  });
});

// ---- T2: the handler the host actually receives ----

const roots = [];

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

function scratch(tag) {
  return fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), `odd-wt-guard-${tag}-`))));
}

function makeRepo() {
  const dir = scratch('repo');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function makeLinkedWorktree(repo) {
  const target = path.join(scratch('linked'), 'odd-a');
  git(repo, ['worktree', 'add', '-b', 'feat/odd-a', target]);
  return fs.realpathSync(target);
}

// The host's `tool_call` round trip: every registered handler in turn, and the first
// block answer is the block the host sees.
async function callTool(hooks, event, cwd) {
  const handlers = hooks.filter(([name]) => name === 'tool_call').map(([, handler]) => handler);
  for (const handler of handlers) {
    const answer = await handler(event, { cwd });
    if (answer !== undefined) return answer;
  }
  return undefined;
}

const bash = (command) => ({ toolName: 'bash', input: { command } });

describe('the tool_call handler the extension registers', () => {
  let loaded;
  let principal;
  let linked;
  let outside;

  before(async () => {
    loaded = await loadExtension({});
    principal = makeRepo();
    linked = makeLinkedWorktree(principal);
    outside = scratch('loose');
  });

  after(() => {
    for (const dir of roots) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a temp directory that is already gone is fine.
      }
    }
  });

  test('refuses worktree creation in any cwd and lets listing through', async () => {
    for (const cwd of [principal, linked, outside]) {
      assert.deepEqual(
        await callTool(loaded.hooks, bash('git worktree add ../odd-b'), cwd),
        { block: true, reason: WORKTREE_ADD_REFUSAL },
        `add in ${cwd}`,
      );
      assert.deepEqual(
        await callTool(loaded.hooks, bash('git worktree list --porcelain'), cwd),
        undefined,
        `list in ${cwd}`,
      );
      assert.deepEqual(
        await callTool(loaded.hooks, bash(`git -C ${principal} worktree add ../odd-b`), cwd),
        { block: true, reason: WORKTREE_ADD_REFUSAL },
        `-C add in ${cwd}`,
      );
    }
  });

  test('refuses the switches that leave the principal checkout\'s default branch', async () => {
    const expected = [
      ['git checkout -b feat/odd-b', BRANCH_SWITCH_REFUSAL],
      ['git switch -c feat/odd-b', BRANCH_SWITCH_REFUSAL],
      ['git checkout develop', BRANCH_SWITCH_REFUSAL],
      ['git switch develop', BRANCH_SWITCH_REFUSAL],
      ['git checkout feat/odd-b', BRANCH_SWITCH_REFUSAL],
      ['git switch feat/odd-b', BRANCH_SWITCH_REFUSAL],
      ['git checkout origin/main', BRANCH_SWITCH_REFUSAL],
      ['git checkout -', BRANCH_SWITCH_REFUSAL],
      ['git switch --detach', BRANCH_SWITCH_REFUSAL],
      [`git checkout ${SHA_REF.slice(0, 7)}`, BRANCH_SWITCH_REFUSAL],
      ['git status && git checkout develop', BRANCH_SWITCH_REFUSAL],
      ['echo $(git worktree add ../odd-b)', WORKTREE_ADD_REFUSAL],
    ];
    for (const [command, reason] of expected) {
      assert.deepEqual(await callTool(loaded.hooks, bash(command), principal), { block: true, reason }, command);
    }
  });

  test('creating a branch in the principal checkout passes (S3, L10)', async () => {
    for (const command of ['git branch odd-b', 'git branch -f odd-b main', 'git branch -m odd-b odd-c', 'git branch -D odd-c', 'git branch --list']) {
      assert.equal(await callTool(loaded.hooks, bash(command), principal), undefined, command);
    }
  });

  test('a principal checkout on another branch is not blocked', async () => {
    const other = makeRepo();
    git(other, ['checkout', '-b', 'feat/elsewhere']);
    for (const command of ['git checkout develop', 'git switch develop', 'git checkout -', 'git switch -c feat/another', 'git checkout main']) {
      assert.equal(await callTool(loaded.hooks, bash(command), other), undefined, command);
    }
  });

  test('the command\'s own cd decides which checkout is judged (S11)', async () => {
    assert.equal(await callTool(loaded.hooks, bash(`cd ${linked} && git switch develop`), principal), undefined);
    assert.deepEqual(
      await callTool(loaded.hooks, bash(`cd ${linked} && cd ${principal} && git switch develop`), linked),
      { block: true, reason: BRANCH_SWITCH_REFUSAL },
    );
    assert.equal(await callTool(loaded.hooks, bash('cd $HOME && git switch develop'), principal), undefined);
  });

  test('allows the same branch work inside a linked worktree', async () => {
    for (const command of [
      'git checkout -b feat/odd-b',
      'git switch -c feat/odd-b',
      'git branch odd-b',
      'git checkout develop',
      'git switch develop',
      'git checkout -',
    ]) {
      assert.equal(await callTool(loaded.hooks, bash(command), linked), undefined, command);
    }
  });

  test('a checkout of a file that exists is a restore, one that does not is a branch', async () => {
    fs.mkdirSync(path.join(principal, 'src'), { recursive: true });
    fs.writeFileSync(path.join(principal, 'src', 'real.txt'), 'x');
    assert.equal(await callTool(loaded.hooks, bash('git checkout src/real.txt'), principal), undefined);
    assert.deepEqual(
      await callTool(loaded.hooks, bash('git checkout src/missing.txt'), principal),
      { block: true, reason: BRANCH_SWITCH_REFUSAL },
    );
  });

  test('ODD_WORKTREE_GUARD=0 turns the guards off, and only that value', async () => {
    const previous = process.env.ODD_WORKTREE_GUARD;
    try {
      for (const value of ['0', 'false', '', '1']) {
        process.env.ODD_WORKTREE_GUARD = value;
        const answer = await callTool(loaded.hooks, bash('git worktree add ../odd-b'), principal);
        if (value === '0') assert.equal(answer, undefined, 'value "0" turns them off');
        else assert.deepEqual(answer, { block: true, reason: WORKTREE_ADD_REFUSAL }, `value ${JSON.stringify(value)}`);
      }
      delete process.env.ODD_WORKTREE_GUARD;
      assert.deepEqual(
        await callTool(loaded.hooks, bash('git worktree add ../odd-b'), principal),
        { block: true, reason: WORKTREE_ADD_REFUSAL },
        'unset keeps them on',
      );
    } finally {
      if (previous === undefined) delete process.env.ODD_WORKTREE_GUARD;
      else process.env.ODD_WORKTREE_GUARD = previous;
    }
  });

  test('lets every other call through', async () => {
    const calls = [
      bash('git status'),
      bash('git checkout main'),
      bash('git branch feat/odd-b'),
      bash('git worktree remove ../odd-a'),
      bash('git worktree prune'),
      { toolName: 'read', input: { path: path.join(principal, 'README.md') } },
      { toolName: 'write', input: { path: path.join(outside, 'a.txt'), content: 'x' } },
      { toolName: 'grep', input: { pattern: 'main', path: principal } },
      { toolName: 'worktree_create', input: { odd: 'odd-b', branch: 'feat/odd-b' } },
      { toolName: 'worktree_list', input: {} },
    ];
    for (const event of calls) {
      assert.equal(await callTool(loaded.hooks, event, principal), undefined, JSON.stringify(event));
    }
  });

  test('outside a repository, and on a cwd that does not exist, it refuses nothing about branches', async () => {
    const missing = path.join(os.tmpdir(), `odd-wt-guard-missing-${process.pid}-${Date.now()}`);
    for (const cwd of [outside, missing]) {
      assert.equal(await callTool(loaded.hooks, bash('git checkout develop'), cwd), undefined, cwd);
      assert.equal(await callTool(loaded.hooks, bash('git checkout -b feat/odd-b'), cwd), undefined, cwd);
      // S1 stays in force: creating a worktree is refused wherever the session stands.
      assert.deepEqual(await callTool(loaded.hooks, bash('git worktree add ../odd-b'), cwd), { block: true, reason: WORKTREE_ADD_REFUSAL }, cwd);
    }
  });
});

'use strict';
// S4 (L2): the `edit`/`write` guard, decided from the paths a call touches, plus the
// `tool_call` wiring the host actually receives.
//
// The rule is one sentence: a path that lies inside the PRINCIPAL checkout of the
// session's own repository, while that checkout is on the repository's default branch,
// is refused before it is written. Everything else passes — and the pass list is the
// bigger half of this file, because L2 is what the human asked for: a path outside
// every repository, a path under the OS temp directories (even a scratch repository
// there), a path in another repository, a path in a linked worktree, a session outside
// version control, an unreadable identity, a detached HEAD, another branch, a default
// branch that does not resolve, and a path that cannot be placed at all.
//
// The block cases need a directory that really exists and is NOT under a temp
// directory, because a temp path is exempt by the rule itself. They use the checkout
// this suite runs in: the guard only realpaths directories, so nothing is written and
// no fixture repository is created for them. The linked/temp cases use throwaway
// directories under the system temp directory, removed in teardown.
//
// The wiring half stubs the two git answers the extension reads (the checkout's
// identity and its branch), because a repository cannot be created outside the temp
// directories a test may write to, and a temp repository must pass (L2). What is
// under test there is the plumbing: the registered handler, the paths it reads, the
// reason it returns, the switch, and the fact that `bash` is judged exactly as before.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decideWriteGuard } = require('../lib/worktree-guard.js');
const { loadExtension } = require('./fixtures/load-extension.js');

const WORKTREE_ADD_REFUSAL = '`git worktree add` did not run: create the ODD\'s checkout with `worktree_create`.';
const BRANCH_SWITCH_REFUSAL = 'The branch switch did not run: the principal checkout stays on its default branch. Create the ODD\'s checkout with `worktree_create`.';

// The one sentence S4 states, written out here: a reworded sentence fails this file.
function refusal(file, branch = 'main') {
  return `${file} is in the primary checkout on \`${branch}\`. Work in a worktree (\`worktree_list\` / \`worktree_create\`).`;
}

// A real checkout that is NOT under an OS temp directory: the one this suite runs in.
// Only directories are realpath'd; nothing is written there.
const PRINCIPAL = fs.realpathSync(path.resolve(__dirname, '..'));
// The guard exempts every temp path by rule (L2), so a suite that itself runs from a temp
// directory cannot use its own checkout as a refused fixture: those cases skip there, and
// the virtual-principal cases at the bottom of this file still cover the refusal.
const UNDER_TEMP = [...new Set(['/tmp', '/var/tmp', os.tmpdir(), process.env.TMPDIR].filter(Boolean).flatMap((dir) => {
  const spellings = [path.resolve(dir)];
  try { spellings.push(fs.realpathSync(dir)); } catch { /* an absent temp dir contributes its spelling only */ }
  return spellings;
}))].some((root) => PRINCIPAL === root || PRINCIPAL.startsWith(`${root}${path.sep}`));
const NEEDS_NON_TEMP = UNDER_TEMP ? 'the suite checkout lives under a temp directory, which the guard exempts' : false;
const PRINCIPAL_FILE = path.join(PRINCIPAL, 'lib', 'not-yet-there.js');
// The one directory the fake identities spell as the shared git dir of PRINCIPAL.
const PRINCIPAL_COMMON = path.join(PRINCIPAL, '.git');

const scratchDirs = [];

function scratch(tag) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `odd-write-guard-${tag}-`)));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a directory that is already gone is fine.
    }
  }
});

// The module's one entry point over fake seams. Each seam counts its reads, so "read
// only when the rule needs it" is observable, and a seam may be an Error to prove the
// guard fails open.
function harness(options = {}) {
  const reads = { identity: 0, defaultBranch: 0, currentBranch: 0 };
  const identity = 'identity' in options
    ? options.identity
    : { root: PRINCIPAL, commonDir: PRINCIPAL_COMMON };
  const defaultBranch = 'defaultBranch' in options ? options.defaultBranch : 'main';
  const currentBranch = 'currentBranch' in options ? options.currentBranch : 'main';
  const run = (paths, callOptions = {}) => decideWriteGuard({
    toolName: 'toolName' in callOptions ? callOptions.toolName : 'edit',
    paths,
    cwd: 'cwd' in callOptions ? callOptions.cwd : PRINCIPAL,
    repoIdentity: (cwd) => {
      reads.identity += 1;
      if (identity instanceof Error) throw identity;
      return typeof identity === 'function' ? identity(cwd) : identity;
    },
    defaultBranch: (root) => {
      reads.defaultBranch += 1;
      if (defaultBranch instanceof Error) throw defaultBranch;
      return typeof defaultBranch === 'function' ? defaultBranch(root) : defaultBranch;
    },
    currentBranch: (root) => {
      reads.currentBranch += 1;
      if (currentBranch instanceof Error) throw currentBranch;
      return typeof currentBranch === 'function' ? currentBranch(root) : currentBranch;
    },
  });
  return { run, reads };
}

// ---- S4: the refusal itself ----

describe('the refusal is one sentence (S4)', () => {
  test('a path inside the primary checkout on the default branch is refused with the exact sentence', { skip: NEEDS_NON_TEMP }, () => {
    const { run } = harness();
    assert.deepEqual(run([PRINCIPAL_FILE]), { block: true, reason: refusal(PRINCIPAL_FILE) });
  });

  test('the sentence carries the real path and the real default branch, and nothing else', { skip: NEEDS_NON_TEMP }, () => {
    const { run } = harness({ defaultBranch: 'trunk', currentBranch: 'trunk' });
    const decision = run([PRINCIPAL_FILE]);
    assert.equal(decision.reason, refusal(PRINCIPAL_FILE, 'trunk'));
    assert.equal(decision.reason.includes('main'), false, 'no `main` is assumed');
    assert.equal(decision.reason.split('. ').length, 2, 'one sentence, then the reminder');
    assert.equal(decision.reason.includes('!'), false, 'no exclamation');
    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(decision.reason), false, 'no emoji');
    assert.ok(decision.reason.endsWith('.'), 'ends with a period');
    for (const tool of ['`worktree_list`', '`worktree_create`']) {
      assert.ok(decision.reason.includes(tool), `names ${tool}`);
    }
  });

  test('both writing tools are guarded, and a `write` of a new file is judged by its directory', { skip: NEEDS_NON_TEMP }, () => {
    // A nested path whose own directory exists and whose file does not: nothing is
    // created, and the directory is still what places it.
    const nested = path.join(PRINCIPAL, 'lib', 'odd-prompt', 'child-probe.md');
    for (const toolName of ['edit', 'write']) {
      const { run } = harness();
      assert.deepEqual(run([nested], { toolName }), { block: true, reason: refusal(nested) }, toolName);
    }
  });

  test('a relative path is resolved against the session cwd and reported absolute', { skip: NEEDS_NON_TEMP }, () => {
    const { run } = harness();
    assert.deepEqual(run(['lib/not-yet-there.js']), { block: true, reason: refusal(PRINCIPAL_FILE) });
  });

  test('one path inside the checkout refuses the call even when another passes', { skip: NEEDS_NON_TEMP }, () => {
    const loose = scratch('loose');
    const { run } = harness();
    assert.deepEqual(run([path.join(loose, 'a.txt'), PRINCIPAL_FILE]), { block: true, reason: refusal(PRINCIPAL_FILE) });
  });
});

// ---- L2: everything else passes ----

describe('L2: a path the guard cannot place in the session\'s repository passes', () => {
  test('a path outside every repository passes, and a temp path reads no repository state', () => {
    const loose = scratch('outside');
    fs.writeFileSync(path.join(loose, 'plan.txt'), 'x\n');
    const { run, reads } = harness();
    assert.deepEqual(run([path.join(loose, 'plan.txt')]), { block: false });
    assert.deepEqual(run([path.join(loose, 'new-file.txt')]), { block: false });
    assert.deepEqual(reads, { identity: 0, defaultBranch: 0, currentBranch: 0 },
      'a path a checkout cannot own is settled before any git answer is asked for');
  });

  test('a path under the OS temp directory passes even when a scratch repository lives there', { skip: NEEDS_NON_TEMP }, () => {
    const repo = scratch('scratch-repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const identity = { root: repo, commonDir: path.join(repo, '.git') };
    const temp = harness({ identity, cwd: repo });
    assert.deepEqual(temp.run([path.join(repo, 'scratch.txt')], { cwd: repo }), { block: false });
    assert.deepEqual(temp.run(['scratch.txt'], { cwd: repo }), { block: false });
    assert.deepEqual(temp.reads, { identity: 0, defaultBranch: 0, currentBranch: 0 },
      'a temp path costs no git at all, whatever repository it is in');
    // The very same path shape outside the temp directories is placed, and then it is
    // another repository's file, so it passes for that reason instead.
    const outside = harness({ identity, cwd: repo });
    assert.deepEqual(outside.run([PRINCIPAL_FILE], { cwd: repo }), { block: false });
    assert.equal(outside.reads.identity, 1, 'a non-temp path asks which checkout the session stands in');
  });

  test('a path under TMPDIR passes, and so does one under /tmp', () => {
    const saved = process.env.TMPDIR;
    const dir = scratch('tmpdir');
    process.env.TMPDIR = dir;
    try {
      const identity = { root: dir, commonDir: path.join(dir, '.git') };
      const { run } = harness({ identity, cwd: dir });
      assert.deepEqual(run([path.join(dir, 'a.txt')], { cwd: dir }), { block: false });
      assert.deepEqual(run([path.join(os.tmpdir(), 'odd-write-guard-probe', 'a.txt')]), { block: false });
      assert.deepEqual(run(['/tmp/odd-write-guard-probe.txt']), { block: false });
      assert.deepEqual(run(['/var/tmp/odd-write-guard-probe.txt']), { block: false });
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  test('a path in another repository than the session\'s cwd passes', () => {
    const other = scratch('other-repo');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    // The session stands in the other repository, and the path is in PRINCIPAL: another
    // repository's file, so nothing is judged.
    const identity = (cwd) => (path.resolve(String(cwd)) === other
      ? { root: other, commonDir: path.join(other, '.git') }
      : undefined);
    const { run } = harness({ identity, cwd: other });
    assert.deepEqual(run([PRINCIPAL_FILE], { cwd: other }), { block: false });
    assert.deepEqual(run([path.join(other, 'a.txt')], { cwd: other }), { block: false });
  });

  test('a path inside a linked worktree passes, and so does any path when the session stands in one', () => {
    const linked = scratch('linked');
    const identity = { root: linked, commonDir: PRINCIPAL_COMMON };
    const { run } = harness({ identity, cwd: linked });
    assert.deepEqual(run([path.join(linked, 'note.md')], { cwd: linked }), { block: false });
    assert.deepEqual(run([path.join(linked, 'odd', 'tasks', 'plan.md')], { cwd: linked }), { block: false });
  });

  test('a linked worktree or a nested repository that lives INSIDE the principal directory passes: the path\'s own checkout decides', { skip: NEEDS_NON_TEMP }, () => {
    const nested = path.join(PRINCIPAL, 'lib');
    const identity = (cwd) => (cwd === nested
      ? { root: nested, commonDir: PRINCIPAL_COMMON }
      : { root: PRINCIPAL, commonDir: PRINCIPAL_COMMON });
    const { run } = harness({ identity });
    assert.deepEqual(run([path.join(nested, 'a.js')]), { block: false });
    assert.equal(run([PRINCIPAL_FILE.replace(`${path.sep}lib${path.sep}`, `${path.sep}docs${path.sep}`)]).block, true, 'the principal\'s own directories still block');
  });

  test('a session cwd outside version control passes, and reads no branch', () => {
    const loose = scratch('no-repo');
    for (const identity of [new Error('not a git repository'), undefined, null, {}, { root: '/' }, { commonDir: 'x' }]) {
      const { run, reads } = harness({ identity, cwd: loose });
      assert.deepEqual(run([path.join(loose, 'a.txt')], { cwd: loose }), { block: false }, String(identity));
      assert.deepEqual(run([PRINCIPAL_FILE], { cwd: loose }), { block: false }, String(identity));
      assert.equal(reads.currentBranch, 0, `${String(identity)}: no branch is read`);
      assert.equal(reads.defaultBranch, 0, `${String(identity)}: no default branch is read`);
    }
  });

  test('a detached HEAD, an unreadable branch and another branch never block', () => {
    for (const currentBranch of [undefined, '', new Error('detached HEAD'), 'feat/odd-a', 'develop']) {
      const { run } = harness({ currentBranch });
      assert.deepEqual(run([PRINCIPAL_FILE]), { block: false }, String(currentBranch));
    }
  });

  test('a default branch that does not resolve blocks nothing', () => {
    for (const defaultBranch of [undefined, '', new Error('git config failed')]) {
      const { run } = harness({ defaultBranch });
      assert.deepEqual(run([PRINCIPAL_FILE]), { block: false }, String(defaultBranch));
    }
  });

  test('a principal checkout named by a common dir that is not a `.git` fails open', () => {
    const separate = { root: PRINCIPAL, commonDir: path.join(PRINCIPAL, 'git-dir') };
    const { run } = harness({ identity: separate });
    assert.deepEqual(run([PRINCIPAL_FILE]), { block: false });
  });

  test('a path whose directory cannot be resolved passes', () => {
    const absent = path.join(PRINCIPAL, 'not-a-directory-of-this-repository', 'file.md');
    const { run } = harness();
    assert.deepEqual(run([absent]), { block: false });
  });

  test('a symlink into the primary checkout is judged by the real directory, and one out of it too', { skip: NEEDS_NON_TEMP }, () => {
    const links = scratch('links');
    fs.symlinkSync(path.join(PRINCIPAL, 'lib'), path.join(links, 'into-lib'), 'dir');
    const tempRepo = scratch('linked-target');
    fs.mkdirSync(path.join(tempRepo, '.git'), { recursive: true });
    fs.symlinkSync(tempRepo, path.join(links, 'into-temp'), 'dir');
    try {
      // A temp spelling of a primary path does not dodge the check...
      const { run } = harness();
      assert.deepEqual(
        run([path.join(links, 'into-lib', 'not-yet-there.js')]),
        { block: true, reason: refusal(PRINCIPAL_FILE) },
      );
      // ...and a primary-looking spelling of a temp path does not false-trip it.
      const identity = { root: PRINCIPAL, commonDir: PRINCIPAL_COMMON };
      const other = harness({ identity });
      assert.deepEqual(other.run([path.join(links, 'into-temp', 'a.txt')]), { block: false });
    } finally {
      for (const name of ['into-lib', 'into-temp']) {
        try {
          fs.unlinkSync(path.join(links, name));
        } catch {
          // The scratch directory is removed in teardown anyway.
        }
      }
    }
  });

  test('every other tool passes, reading no repository state at all', () => {
    for (const toolName of ['read', 'bash', 'grep', 'find', 'ls', 'worktree_create', 'worktree_list', 'odd_write']) {
      const { run, reads } = harness();
      assert.deepEqual(run([PRINCIPAL_FILE], { toolName }), { block: false }, toolName);
      assert.deepEqual(reads, { identity: 0, defaultBranch: 0, currentBranch: 0 }, `${toolName} reads nothing`);
    }
  });
});

// ---- S8: honest failure, never a throw and never a false block ----

describe('S8: an unreadable repository fails open, and nothing throws', () => {
  test('a seam that throws never escapes and never blocks', () => {
    for (const options of [
      { identity: new Error('boom') },
      { defaultBranch: new Error('boom') },
      { currentBranch: new Error('boom') },
      { identity: new Error('boom'), defaultBranch: new Error('boom'), currentBranch: new Error('boom') },
    ]) {
      const { run } = harness(options);
      assert.deepEqual(run([PRINCIPAL_FILE]), { block: false }, JSON.stringify(Object.keys(options)));
    }
  });

  test('input that names nothing decides nothing', () => {
    const { run } = harness();
    for (const paths of [undefined, null, [], [''], [42], [{}]]) {
      assert.deepEqual(run(paths), { block: false }, String(paths));
    }
    assert.deepEqual(decideWriteGuard(undefined), { block: false });
    assert.deepEqual(decideWriteGuard({}), { block: false });
    assert.deepEqual(decideWriteGuard({ toolName: 'write', paths: [PRINCIPAL_FILE] }), { block: false },
      'no cwd, no identity seam: nothing is judged');
  });

  test('an unknown cwd decides nothing', () => {
    const { run, reads } = harness();
    for (const cwd of [undefined, null, '', 0]) {
      assert.deepEqual(run([PRINCIPAL_FILE], { cwd }), { block: false }, String(cwd));
    }
    assert.deepEqual(reads, { identity: 0, defaultBranch: 0, currentBranch: 0 }, 'nothing is read');
  });

  test('a block reads the session identity, the owner of the path and each branch once, and only after a path was placed', { skip: NEEDS_NON_TEMP }, () => {
    const { run, reads } = harness();
    assert.deepEqual(run([PRINCIPAL_FILE, path.join(PRINCIPAL, 'README.md')]), { block: true, reason: refusal(PRINCIPAL_FILE) });
    assert.deepEqual(reads, { identity: 2, defaultBranch: 1, currentBranch: 1 });
  });
});

// ---- S4: the handler the host actually receives ----

const bash = (command) => ({ toolName: 'bash', input: { command } });
const edit = (file) => ({ toolName: 'edit', input: { path: file } });
const write = (file) => ({ toolName: 'write', input: { path: file, content: 'x\n' } });

describe('the tool_call handler the extension registers (S4)', () => {
  let loaded;
  let git;
  let linked;
  let principalBranch;
  let savedIdentity;
  let savedRunArgv;

  // The first block answer is the block the host sees, exactly as the host walks its
  // handlers.
  async function callTool(event, cwd) {
    for (const [name, handler] of loaded.hooks) {
      if (name !== 'tool_call') continue;
      const answer = await handler(event, { cwd });
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  const principalIdentity = { root: PRINCIPAL, commonDir: PRINCIPAL_COMMON };
  const linkedIdentity = () => ({ root: linked, commonDir: PRINCIPAL_COMMON });

  before(async () => {
    loaded = await loadExtension({});
    // The lib instance the extension itself calls: its git answers are the seams the
    // guard reads, so the fake world below reaches the real handler.
    git = require('../lib/worktree-git.js');
    linked = scratch('wiring-linked');
    fs.writeFileSync(path.join(linked, 'note.md'), '# note\n');
    principalBranch = 'main';
    savedIdentity = git.repoIdentity;
    savedRunArgv = git.runArgv;
    git.repoIdentity = (cwd) => {
      const resolved = path.resolve(String(cwd));
      if (resolved === PRINCIPAL || resolved.startsWith(`${PRINCIPAL}${path.sep}`)) return principalIdentity;
      if (resolved === linked) return linkedIdentity();
      throw new Error(`not a git repository: ${cwd}`);
    };
    git.runArgv = (_bin, args, opts = {}) => {
      const key = Array.isArray(args) ? args.join(' ') : '';
      const cwd = typeof opts.cwd === 'string' ? path.resolve(opts.cwd) : '';
      if (key === 'rev-parse --verify --quiet refs/heads/main') {
        return { status: 0, stdout: 'a1b2c3\n', stderr: '', error: null };
      }
      if (key === 'symbolic-ref --quiet --short HEAD') {
        // Read fresh on every call, exactly as the guard asks it.
        const name = cwd === PRINCIPAL ? principalBranch : 'feat/linked';
        return name.length === 0
          ? { status: 1, stdout: '', stderr: '', error: null }
          : { status: 0, stdout: `${name}\n`, stderr: '', error: null };
      }
      return { status: 1, stdout: '', stderr: '', error: null };
    };
  });

  after(() => {
    if (git && savedIdentity !== undefined) git.repoIdentity = savedIdentity;
    if (git && savedRunArgv !== undefined) git.runArgv = savedRunArgv;
  });

  test('an edit and a write into the primary checkout on main are refused with the sentence', { skip: NEEDS_NON_TEMP }, async () => {
    principalBranch = 'main';
    const target = path.join(PRINCIPAL, 'lib', 'wiring-probe.js');
    const second = path.join(PRINCIPAL, 'lib', 'wiring-probe-2.js');
    assert.deepEqual(await callTool(edit(target), PRINCIPAL), { block: true, reason: refusal(target) });
    assert.deepEqual(await callTool(write(second), PRINCIPAL), { block: true, reason: refusal(second) });
    assert.deepEqual(await callTool(edit('lib/wiring-probe.js'), PRINCIPAL), { block: true, reason: refusal(target) });
  });

  test('the same call in a linked worktree passes', async () => {
    principalBranch = 'main';
    assert.equal(await callTool(edit(path.join(linked, 'note.md')), linked), undefined);
    assert.equal(await callTool(write(path.join(linked, 'other.md')), linked), undefined);
  });

  test('a primary checkout on another branch passes, and the branch is read fresh', { skip: NEEDS_NON_TEMP }, async () => {
    const target = path.join(PRINCIPAL, 'lib', 'wiring-probe.js');
    principalBranch = 'feat/elsewhere';
    assert.equal(await callTool(edit(target), PRINCIPAL), undefined);
    principalBranch = 'main';
    assert.deepEqual(await callTool(edit(target), PRINCIPAL), { block: true, reason: refusal(target) });
    principalBranch = '';
    assert.equal(await callTool(edit(target), PRINCIPAL), undefined, 'a detached HEAD blocks nothing');
  });

  test('a read anywhere, and a bash call, are judged exactly as before', async () => {
    principalBranch = 'main';
    const target = path.join(PRINCIPAL, 'README.md');
    assert.equal(await callTool({ toolName: 'read', input: { path: target } }, PRINCIPAL), undefined);
    assert.equal(await callTool({ toolName: 'grep', input: { pattern: 'x', path: PRINCIPAL } }, PRINCIPAL), undefined);
    assert.deepEqual(await callTool(bash('git worktree add ../odd-b'), PRINCIPAL), { block: true, reason: WORKTREE_ADD_REFUSAL });
    assert.equal(await callTool(bash('git worktree list --porcelain'), PRINCIPAL), undefined);
    assert.deepEqual(await callTool(bash('git switch develop'), PRINCIPAL), { block: true, reason: BRANCH_SWITCH_REFUSAL });
    assert.equal(await callTool(bash('git switch develop'), linked), undefined);
    assert.equal(await callTool(bash('git status'), PRINCIPAL), undefined);
  });

  test('ODD_WORKTREE_GUARD=0 turns the write guard off, and only that value', { skip: NEEDS_NON_TEMP }, async () => {
    const previous = process.env.ODD_WORKTREE_GUARD;
    principalBranch = 'main';
    const target = path.join(PRINCIPAL, 'lib', 'wiring-probe.js');
    try {
      for (const value of ['0', 'false', '', '1']) {
        process.env.ODD_WORKTREE_GUARD = value;
        const answer = await callTool(edit(target), PRINCIPAL);
        if (value === '0') assert.equal(answer, undefined, 'value "0" turns it off with the bash guards');
        else assert.deepEqual(answer, { block: true, reason: refusal(target) }, `value ${JSON.stringify(value)}`);
      }
      delete process.env.ODD_WORKTREE_GUARD;
      assert.deepEqual(await callTool(edit(target), PRINCIPAL), { block: true, reason: refusal(target) }, 'unset keeps it on');
    } finally {
      if (previous === undefined) delete process.env.ODD_WORKTREE_GUARD;
      else process.env.ODD_WORKTREE_GUARD = previous;
    }
  });
});

// ---- S4: two defects the independent verification found, pinned where they cannot hide ----

// A virtual principal checkout that is NOT under a temp directory and does not exist on
// disk: `fs.realpathSync` is mocked for its two directories only, and the extension's git
// answers are faked, so these cases run from any checkout location (a temp one included).
async function virtualPrimary(t) {
  const { hooks } = await loadExtension({});
  const git = require('../lib/worktree-git.js');
  const root = path.join(path.parse(process.cwd()).root, '__odd_virtual_primary__');
  const dir = path.join(root, 'nested');
  const file = path.join(dir, 'note.md');
  const commonDir = path.join(root, '.git');
  const realpath = fs.realpathSync;
  let nested = false;
  t.mock.method(fs, 'realpathSync', (p, ...args) => (p === root || p === dir ? p : realpath(p, ...args)));
  t.mock.method(git, 'repoIdentity', (p) => ({ root: nested && path.resolve(String(p)) === dir ? dir : root, commonDir }));
  t.mock.method(git, 'runArgv', (_bin, args) => {
    const command = args.join(' ');
    if (command === 'symbolic-ref --quiet --short HEAD') return { status: 0, stdout: 'main\n' };
    if (command === 'rev-parse --verify --quiet refs/heads/main') return { status: 0, stdout: 'abc\n' };
    return { status: 1, stdout: '' };
  });
  return {
    file,
    makeNested: () => { nested = true; },
    async call(raw) {
      for (const [name, hook] of hooks) {
        if (name !== 'tool_call') continue;
        const result = await hook(edit(raw), { cwd: root });
        if (result !== undefined) return result;
      }
      return undefined;
    },
  };
}

test('S4: the `@` prefix Pi strips from a path does not change the guard decision', async (t) => {
  const { call, file } = await virtualPrimary(t);
  assert.deepEqual(await call(`@${file}`), { block: true, reason: refusal(file) });
  assert.deepEqual(await call(file), { block: true, reason: refusal(file) });
});

test('S4: who owns the path\'s directory is asked again, never remembered, after a nested worktree appears', async (t) => {
  const { call, file, makeNested } = await virtualPrimary(t);
  assert.deepEqual(await call(file), { block: true, reason: refusal(file) });
  makeNested();
  assert.equal(await call(file), undefined);
});

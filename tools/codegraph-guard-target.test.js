'use strict';
// T2 (S3, S4, S8): which checkout a finished grep/find/ls/read/bash call went to. The paths and the
// `cd` targets are read from the call alone, the code-file filter applies to `read`, and the git
// toplevel of a directory is read once and cached. Git is a fake map here: no child runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createCheckoutResolver,
  callCheckout,
  isCodeFile,
  searchCall,
} = require('../lib/codegraph-guard-target.js');

const CWD = '/home/dev/projects/example';

const event = (toolName, input) => ({ toolName, input, isError: false, content: [] });

// ---- the code-file filter (S3) ----

test('read counts for code, not for the docs and configs the rule exempts', () => {
  for (const file of ['a.ts', 'a.js', 'Makefile', 'lib/codegraph-guard.js', 'a.tsx', 'a.py']) {
    assert.equal(isCodeFile(file), true, file);
  }
  for (const file of ['a.md', 'a.json', 'a.yml', 'a.yaml', 'a.toml', 'a.txt', 'A.MD', 'docs/README.md']) {
    assert.equal(isCodeFile(file), false, file);
  }
});

// ---- the built-in search tools (S3) ----

test('grep, find and ls name their path, and default to the session checkout', () => {
  assert.deepEqual(searchCall(event('grep', { pattern: 'x' }), CWD), { tool: 'grep', paths: [CWD] });
  assert.deepEqual(searchCall(event('grep', { pattern: 'x', path: 'src' }), CWD), { tool: 'grep', paths: [`${CWD}/src`] });
  assert.deepEqual(searchCall(event('find', { pattern: '*.ts', path: '/other/src' }), CWD), { tool: 'find', paths: ['/other/src'] });
  assert.deepEqual(searchCall(event('ls', {}), CWD), { tool: 'ls', paths: [CWD] });
});

test('read names the file it opened, and only when it is code', () => {
  assert.deepEqual(searchCall(event('read', { path: 'src/a.ts' }), CWD), { tool: 'read', paths: [`${CWD}/src`] });
  assert.deepEqual(searchCall(event('read', { path: '/other/a.ts' }), CWD), { tool: 'read', paths: ['/other'] });
  assert.equal(searchCall(event('read', { path: 'package.json' }), CWD), undefined);
  assert.equal(searchCall(event('read', { path: 'docs/reference.md' }), CWD), undefined);
});

test('anything else is not a search call', () => {
  for (const toolName of ['edit', 'write', 'worktree_create', 'codegraph', 'mcp__codegraph__codegraph_explore']) {
    assert.equal(searchCall(event(toolName, { path: 'src/a.ts' }), CWD), undefined, toolName);
  }
});

// ---- bash (S3) ----

test('the shell session that cd-ed into another project is a call into that project', () => {
  const command = 'cd /home/tester/projects/other-project && cat package.json 2>/dev/null | head -60 && echo "---FILES---" && find . -type f -not -path \'./.git/*\' -not -path \'./node_modules/*\' | head -80';
  const call = searchCall(event('bash', { command }), CWD);
  assert.equal(call.tool, 'bash');
  assert.ok(call.paths.includes('/home/tester/projects/other-project'), 'the cd target is named');
  assert.deepEqual(call.paths, ['/home/tester/projects/other-project'], 'and nothing of the session checkout survives the cd');
});

test('a chain of reads with no other path stays in the session checkout', () => {
  const command = 'sed -n 150,230p src/types.ts && echo "=====CONTRACT 523-620=====" && sed -n 523,620p docs/contract.md';
  assert.deepEqual(searchCall(event('bash', { command }), CWD), { tool: 'bash', paths: [CWD] });
});

test('an absolute path argument of a read verb names the checkout it reads', () => {
  const call = searchCall(event('bash', { command: 'grep -rn "explore" /other/src' }), CWD);
  assert.ok(call.paths.includes('/other/src'));
  assert.ok(call.paths.includes(CWD), 'the session checkout is still where the shell is');
  const cat = searchCall(event('bash', { command: 'cat /other/src/a.ts > /tmp/out' }), CWD);
  assert.ok(cat.paths.includes('/other/src/a.ts'));
});

test('a command that only mentions a checkout is not a call into it', () => {
  for (const command of [
    'git -C /other/src log --oneline',
    'curl /other/src/api',
    'echo /other/src',
    'npm view /other/src',
  ]) {
    const call = searchCall(event('bash', { command }), CWD);
    assert.equal(call, undefined, command);
  }
});

test('a quoted string is never a command of its own', () => {
  assert.equal(searchCall(event('bash', { command: 'echo "cat /other/src/a.ts"' }), CWD), undefined);
  assert.deepEqual(searchCall(event('bash', { command: 'grep "a|b" .' }), CWD), { tool: 'bash', paths: [CWD] });
  assert.deepEqual(searchCall(event('bash', { command: 'cd /other && grep x a.ts' }), CWD), { tool: 'bash', paths: ['/other'] });
});

// ---- the git toplevel (S4, S8) ----

const ROOTS = {
  '/repo': '/repo',
  '/repo/src': '/repo',
  '/other': '/other',
  '/other/src': '/other',
};

function countingToplevel() {
  const calls = [];
  const toplevel = async (dir) => {
    calls.push(dir);
    return ROOTS[dir];
  };
  return { calls, toplevel };
}

test('the git toplevel of a directory is read once and cached', async () => {
  const { calls, toplevel } = countingToplevel();
  const resolver = createCheckoutResolver({ toplevel });
  assert.equal(await resolver.rootOf('/repo/src'), '/repo');
  assert.equal(await resolver.rootOf('/repo/src'), '/repo');
  assert.deepEqual(calls, ['/repo/src'], 'one read per directory');
});

test('a file resolves through its directory, with one git read and no repeat', async () => {
  const { calls, toplevel } = countingToplevel();
  const resolver = createCheckoutResolver({ toplevel, isDirectory: (dir) => dir === '/other/src' });
  assert.equal(await resolver.rootOfPath('/other/src/a.ts'), '/other');
  assert.deepEqual(calls, ['/other/src'], 'one local stat decides, then one git read');
  assert.equal(await resolver.rootOfPath('/other/src/a.ts'), '/other');
  assert.equal(await resolver.rootOfPath('/other/src/b.ts'), '/other');
  assert.equal(await resolver.rootOfPath('/other/src'), '/other');
  assert.deepEqual(calls, ['/other/src'], 'the directory is what git answered, once');
});

test('a directory outside any checkout is no checkout, and a failing git is not an error', async () => {
  const { toplevel } = countingToplevel();
  const resolver = createCheckoutResolver({
    toplevel: async (dir) => {
      if (dir === '/tmp') throw new Error('git is gone');
      return toplevel(dir);
    },
  });
  assert.equal(await resolver.rootOf('/tmp'), undefined);
  assert.equal(await resolver.rootOfPath('/nothing.ts'), undefined);
});

test('a call went to the checkout its paths resolve to, and the session checkout is not another one', async () => {
  const { toplevel } = countingToplevel();
  const resolver = createCheckoutResolver({ toplevel });
  const other = await callCheckout({ tool: 'grep', paths: ['/other/src'] }, { rootOfPath: resolver.rootOfPath, ownRoot: '/repo' });
  assert.deepEqual(other, { root: '/other', other: true });
  const own = await callCheckout({ tool: 'grep', paths: ['/repo/src'] }, { rootOfPath: resolver.rootOfPath, ownRoot: '/repo' });
  assert.deepEqual(own, { root: '/repo', other: false });
  const none = await callCheckout({ tool: 'ls', paths: ['/tmp'] }, { rootOfPath: resolver.rootOfPath, ownRoot: '/repo' });
  assert.equal(none, undefined, 'a path outside every checkout triggers nothing');
});

test('the first path in another checkout decides, whatever comes after it', async () => {
  const { toplevel } = countingToplevel();
  const resolver = createCheckoutResolver({ toplevel });
  const found = await callCheckout({ tool: 'bash', paths: ['/repo/src', '/other/src'] }, { rootOfPath: resolver.rootOfPath, ownRoot: '/repo' });
  assert.deepEqual(found, { root: '/other', other: true });
});

test('a verb after a pipe filters the previous command and is not a read of its own', () => {
  const bash = (command) => searchCall({ toolName: 'bash', input: { command } }, '/work/repo');
  for (const command of [
    'curl -s https://example.com | head -5',
    'ps aux | grep node',
    'git log --oneline | tail -3',
    'npm view left-pad versions | sed -n 1,3p',
  ]) {
    assert.equal(bash(command), undefined, command);
  }
  // The command that does the reading still counts, with or without a filter behind it.
  assert.ok(bash('cat src/a.ts | head -5'), 'cat reads, head filters');
  assert.ok(bash('find . -name "*.ts" | grep foo'), 'find reads, grep filters');
  assert.ok(bash('grep -rn foo src | head -20'), 'grep with a path reads');
  assert.equal(bash('echo hi && curl -s x | head -2'), undefined, 'a later pipeline filters too');
});

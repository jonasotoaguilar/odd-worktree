'use strict';
// invariant 22 (T1, T2): the skill-read guard — the reader a `bash` call must not use
// on a skill file, and the sentence that says so.
//
// The guarded forms are one table: every refused and every allowed spelling, through
// the module's one entry point and, for the extension half, through the `tool_call`
// handler the host actually receives. The commands are INPUT TEXT only — the guard
// reads the string and never runs it — so no row below spawns anything, and the only
// scratch this file creates is the throwaway cwd the handler is called with, removed
// in teardown.
//
// Public behavior only: what `decideSkillReadGuard(command)` returns and what the
// handler the extension registered returns.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideSkillReadGuard } = require('../lib/skill-read-guard.js');
const { SHELL_SLOT, defaultShellApi, loadExtension } = require('./fixtures/load-extension.js');

// modular-tools (`Skills+`): the two read rules are their own half and that switch is OFF
// until someone turns it on, so a suite that proves the rule publishes the document first
// and restores the slot after.
const savedShellApi = globalThis[SHELL_SLOT];
async function loadWithModules(modules) {
  const shellApi = defaultShellApi();
  shellApi.api.createStore = () => ({
    get: (key, fallback) => (key === 'modules' && modules !== undefined ? modules : fallback),
    set: () => {},
    delete: () => {},
  });
  globalThis[SHELL_SLOT] = shellApi.api;
  try {
    return await loadExtension({});
  } finally {
    if (savedShellApi === undefined) delete globalThis[SHELL_SLOT];
    else globalThis[SHELL_SLOT] = savedShellApi;
  }
}

// The refusal, written out: a reworded sentence fails here. It says the call did not
// run, names the path it read and the ONE tool that replaces the command.
const refusalFor = (skillPath) => `This bash call was not run: it reads the skill file ${skillPath} — read skill files with the \`read\` tool instead.`;

const SKILL_PATH = '/home/dev/.agents/skills/release/SKILL.md';
const REFERENCE_PATH = '/home/dev/.agents/skills/release/references/commands.md';

// The offending call as it was issued, abridged at the end: one skill read mid-chain,
// among ordinary reading that must keep working.
const REAL_COMMAND = `cd /home/jona/dev/projects/odd-worktree && sed -n '1,80p' /home/jona/.agents/skills/release/SKILL.md; echo '=== reference: commits/PRs + cut a release ==='; sed -n '/,$p' docs/reference.md | head -60; echo '=== release.yml ==='; cat .github/workflows/release.yml | head -80`;
const REAL_SKILL_PATH = '/home/jona/.agents/skills/release/SKILL.md';

// Every refused spelling, with the path the reason must name.
const BLOCKED = [
  [`sed -n '1,80p' ${SKILL_PATH}`, SKILL_PATH],
  [`head -80 ${REFERENCE_PATH}`, REFERENCE_PATH],
  ['cat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['cat ./skills/x/SKILL.md', './skills/x/SKILL.md'],
  ['cat "skills/x/SKILL.md"', 'skills/x/SKILL.md'],
  ["cat 'skills/my skill/SKILL.md'", 'skills/my skill/SKILL.md'],
  ['cat ../skills/x/references/y.md', '../skills/x/references/y.md'],
  ['cat ~/.agents/skills/gentle-ai/SKILL.md', '~/.agents/skills/gentle-ai/SKILL.md'],
  ['head -n 20 skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['tail -5 skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['less skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['more skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['bat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['batcat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['nl skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ["awk '{print}' skills/x/SKILL.md", 'skills/x/SKILL.md'],
  ["sed -e 's/a/b/' skills/x/SKILL.md", 'skills/x/SKILL.md'],
  ["sed -n '/name/p' skills/x/references/commands.md", 'skills/x/references/commands.md'],
  ['cat skills/x/SKILL.md | head -5', 'skills/x/SKILL.md'],
  ['cat skills/x/SKILL.md 2>/dev/null', 'skills/x/SKILL.md'],
  ['cat 2>/dev/null skills/x/SKILL.md', 'skills/x/SKILL.md'],
  // The command position, not the first word: assignments and wrappers come before it.
  ['SKILL_DIR=1 cat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['env FOO=1 cat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['time cat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['nice -n 5 cat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  // A skill read beside ordinary work refuses the whole call.
  ['git status && cat skills/x/SKILL.md', 'skills/x/SKILL.md'],
  ['echo start; sed -n 1p skills/x/SKILL.md', 'skills/x/SKILL.md'],
  [REAL_COMMAND, REAL_SKILL_PATH],
];

// Every allowed spelling: general Markdown, ODD artifacts, a skill path in argument
// text, a heredoc body, search, writes and listings.
const ALLOWED = [
  'sed -n 1p docs/reference.md',
  'sed -n 1,80p docs/reference.md',
  "sed -n '/,$p' docs/reference.md | head -60",
  'cat README.md',
  'head -60 README.md',
  'cat .github/workflows/release.yml | head -80',
  'cat odd/tasks/feature.md',
  'cat odd/tasks/feature.md | head -20',
  'git commit -m "touched skills/x/SKILL.md"',
  "echo 'see skills/x/SKILL.md'",
  "echo '=== skills/x/SKILL.md ==='",
  'grep -n SKILL skills/x/SKILL.md',
  "rg --files-with-matches 'SKILL' skills/",
  'grep -rn skills .github',
  "sed -i 's/a/b/' skills/x/SKILL.md",
  "sed -i.bak 's/a/b/' skills/x/SKILL.md",
  "sed --in-place 's/a/b/' skills/x/SKILL.md",
  'cat > skills/x/SKILL.md',
  'cat >> skills/x/SKILL.md',
  'cat notes/a.md > skills/x/SKILL.md',
  'tee skills/x/SKILL.md',
  'ls skills/',
  'ls -la skills/x',
  'cat $HOME/.agents/skills/x/SKILL.md',
  'cat skills/*/SKILL.md',
  'cat -',
  'cat',
  'cat docs/SKILL.md',
  'cat notes/SKILL.md',
  "sed -e '/skills/p' README.md",
  "awk '/skills/p' README.md",
  'git diff docs/reference.md',
  '',
];

// A heredoc hands its body to the command as data: the skill path in it is never an
// argument, and the same is true of a body a reader cannot delimit.
const HEREDOCS = [
  "cat <<'EOF' > notes.md\nsee skills/x/SKILL.md\nEOF",
  'cat <<EOF\ncat skills/x/SKILL.md\nEOF',
  "git commit -F - <<'MSG'\nmoved skills/x/SKILL.md\nMSG",
];

const bash = (command) => ({ toolName: 'bash', input: { command } });

// ---- the decision itself ----

describe('the decision (invariant 22)', () => {
  test('refuses a reader pointed at a skill file, and names that path', () => {
    for (const [command, skillPath] of BLOCKED) {
      assert.deepEqual(decideSkillReadGuard(command), { block: true, reason: refusalFor(skillPath) }, command);
    }
  });

  test('one call that reads two skills names the first one', () => {
    assert.deepEqual(
      decideSkillReadGuard('cat skills/a/SKILL.md; cat skills/b/SKILL.md'),
      { block: true, reason: refusalFor('skills/a/SKILL.md') },
    );
  });

  test('the refusal says the call did not run and names one tool', () => {
    const { reason } = decideSkillReadGuard('cat skills/x/SKILL.md');
    assert.equal(reason.includes('!'), false, `no exclamation: ${reason}`);
    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(reason), false, `no emoji: ${reason}`);
    assert.match(reason, /was not run:/, `says the command did not run: ${reason}`);
    assert.ok(reason.endsWith('.'), `ends with a period: ${reason}`);
    assert.equal((reason.match(/`[a-z_]+`/g) || []).length, 1, `exactly one tool is named: ${reason}`);
    assert.match(reason, /`read`/, `names read: ${reason}`);
  });

  test('allows everything that is not a read of a skill file', () => {
    for (const command of [...ALLOWED, ...HEREDOCS]) {
      assert.equal(decideSkillReadGuard(command), undefined, command);
    }
  });

  test('garbage never throws and always allows', () => {
    const values = [
      undefined,
      null,
      42,
      {},
      [],
      ['cat'],
      () => 'cat skills/x/SKILL.md',
      "cat 'unterminated",
      "sed -n '1,80p skills/x/SKILL.md",
      'cat <<EOF\nskills/x/SKILL.md',
      '${cat} skills/x/SKILL.md',
      '\u0000',
    ];
    for (const value of values) {
      assert.equal(decideSkillReadGuard(value), undefined, String(value));
    }
  });
});

// ---- the handler the extension registers ----

const roots = [];

function track(dir) {
  roots.push(dir);
  return dir;
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

describe('the tool_call handler the extension registers', () => {
  let loaded;
  let cwd;

  before(async () => {
    loaded = await loadWithModules({ skills: true, worktrees: true });
    cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-skill-read-guard-')));
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

  test('refuses a bash call that reads a skill file', async () => {
    for (const [command, skillPath] of BLOCKED) {
      assert.deepEqual(
        await callTool(loaded.hooks, bash(command), cwd),
        { block: true, reason: refusalFor(skillPath) },
        command,
      );
    }
  });

  test('lets every other call through', async () => {
    for (const command of [...ALLOWED, ...HEREDOCS]) {
      assert.equal(await callTool(loaded.hooks, bash(command), cwd), undefined, command);
    }
  });

  test('Skills+ off — its default — registers nothing: the reader is not refused', async () => {
    for (const modules of [undefined, { skills: false }, { worktrees: false }]) {
      const off = await loadWithModules(modules);
      assert.equal(
        await callTool(off.hooks, bash('cat skills/x/SKILL.md'), cwd),
        undefined,
        JSON.stringify(modules),
      );
    }
  });

  test('leaves every non-bash tool call exactly as the host proposed it', async () => {
    const calls = [
      { toolName: 'read', input: { path: 'skills/x/SKILL.md' } },
      { toolName: 'grep', input: { pattern: 'SKILL', path: 'skills/x' } },
      { toolName: 'edit', input: { path: 'skills/x/SKILL.md' } },
      { toolName: 'worktree_list', input: {} },
    ];
    for (const event of calls) {
      assert.equal(await callTool(loaded.hooks, event, cwd), undefined, JSON.stringify(event));
    }
  });

  test('ODD_WORKTREE_GUARD=0 turns it off, and only that value', async () => {
    const previous = process.env.ODD_WORKTREE_GUARD;
    const command = 'cat skills/x/SKILL.md';
    const expected = { block: true, reason: refusalFor('skills/x/SKILL.md') };
    try {
      for (const value of ['0', 'false', '', '1']) {
        process.env.ODD_WORKTREE_GUARD = value;
        const answer = await callTool(loaded.hooks, bash(command), cwd);
        if (value === '0') assert.equal(answer, undefined, 'value "0" turns it off');
        else assert.deepEqual(answer, expected, `value ${JSON.stringify(value)}`);
      }
      delete process.env.ODD_WORKTREE_GUARD;
      assert.deepEqual(await callTool(loaded.hooks, bash(command), cwd), expected, 'unset keeps it on');
    } finally {
      if (previous === undefined) delete process.env.ODD_WORKTREE_GUARD;
      else process.env.ODD_WORKTREE_GUARD = previous;
    }
  });

  test('the worktree guard keeps precedence when one call does both', async () => {
    const answer = await callTool(loaded.hooks, bash('git worktree add ../odd-b && cat skills/x/SKILL.md'), cwd);
    assert.equal(answer.block, true, 'the call is refused');
    assert.match(answer.reason, /`worktree_create`/, `the worktree refusal is the one shown: ${answer.reason}`);
  });

  test('garbage events never throw and always allow', async () => {
    const events = [
      { toolName: 'bash' },
      { toolName: 'bash', input: {} },
      { toolName: 'bash', input: { command: 42 } },
      { toolName: 'bash', input: { command: {} } },
      { toolName: 'bash', input: { command: "cat 'unterminated" } },
      {},
      null,
    ];
    for (const event of events) {
      assert.equal(await callTool(loaded.hooks, event, cwd), undefined, JSON.stringify(event));
    }
  });
});

// ---- regressions an independent verification found ----
test('a skill is read through a real argument, not a search pattern or a normalised-away folder', () => {
	const skill = 'skills/x/SKILL.md';
	for (const command of [
		`sed -ne'1p' ${skill}`,
		`cat < ${skill}`,
		`timeout 5s head ${skill}`,
		`sudo cat ${skill}`,
		`cat <<'EOF' | head ${skill}\ntext\nEOF`,
		`cat "skills/x/[draft].md"`,
	]) {
		const decision = decideSkillReadGuard(command);
		assert.equal(decision && decision.block, true, command);
	}
	for (const command of ['cat skills/../README.md', `less +/${skill} docs/reference.md`, 'cat skills/x/[draft].md']) {
		assert.equal(decideSkillReadGuard(command), undefined, command);
	}
});

test('a skill read in shell syntax is refused, and a mention or a usage request is not', () => {
	const skill = 'skills/x/SKILL.md';
	for (const command of [
		`cat <<'EOF' ${skill}\nhello\nEOF`,
		`command cat ${skill}`,
		`bash -c 'cat ${skill}'`,
		`if true; then cat ${skill}; fi`,
	]) {
		const decision = decideSkillReadGuard(command);
		assert.equal(decision && decision.block, true, command);
		assert.ok(decision.reason.includes(skill), command);
	}
	for (const command of [
		`cat <<'ONE' <<'TWO'\nfirst\nONE\ncat ${skill}\nTWO`,
		`echo hello # && cat ${skill}`,
		`cat --help ${skill}`,
	]) {
		assert.equal(decideSkillReadGuard(command), undefined, command);
	}
});

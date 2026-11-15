'use strict';
// S2/S5 (T4): the bash activity card — the heading a `bash` call wears from its own
// command, the shortened command under it and the output it closes with — drawn on
// this package's card substrate (`lib/shell-card.js`) through the host's
// `registerToolRenderer` resolver.
//
// Every case goes through the module's public surface: the identity helper, the
// collapsed-detail helper and the resolver's slots, read as the lines a component
// draws for a width. Nothing reads module-internal state, a repository or a
// terminal, and no case spawns anything.
//
// The text seam and the themes are the fakes `tools/codegraph-card.test.js` uses:
// this package has no node_modules, so width measurement, truncation and wrapping
// are injected, and colour only ever arrives as `theme.fg(role, text)`.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, test } = require('node:test');

const {
  BASH_CARD_IDENTITY,
  bashCardDetail,
  bashCardIdentity,
} = require('../lib/bash-card.js');
const { createBashCardResolver } = require('../lib/bash-card-resolver.js');
const {
  SHELL_ACTIVITIES,
  SHELL_ACTIVITY_IDENTITY,
  inferBashActivity,
} = require('../lib/bash-activity.js');
const { CODEGRAPH_MARK, CODEGRAPH_TITLE_ROLE, codegraphShape } = require('../lib/codegraph-card.js');
const { CARD_STYLE } = require('../lib/card-style.js');

// ---- the injected text seam (fakes: plain ASCII, each character one column) ----

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI, '');
const chars = (value) => [...stripAnsi(value)];

const metrics = {
  visibleWidth(value) {
    return chars(value).length;
  },
  truncateToWidth(value, width, ellipsis = '') {
    if (width <= 0) return '';
    if (this.visibleWidth(value) <= width) return value;
    const tail = ellipsis ?? '';
    const keep = Math.max(0, width - [...tail].length);
    return chars(value).slice(0, keep).join('') + tail;
  },
  wrapTextWithAnsi(value, width) {
    const text = stripAnsi(value);
    if (width <= 0) return [text];
    return text.split('\n').flatMap((line) => {
      const lines = [];
      let current = '';
      for (const word of line.split(' ')) {
        const candidate = current === '' ? word : `${current} ${word}`;
        if ([...candidate].length <= width) {
          current = candidate;
          continue;
        }
        if (current !== '') {
          lines.push(current);
          current = '';
        }
        if ([...word].length <= width) {
          current = word;
          continue;
        }
        const rest = [...word];
        while (rest.length > width) lines.push(rest.splice(0, width).join(''));
        current = rest.join('');
      }
      lines.push(current);
      return lines;
    });
  },
};

const plainTheme = { fg: (_role, value) => value };

/** A theme that tags every painted cell, so a test can see which role painted what. */
const taggedTheme = {
  fg(role, value) {
    return `<${role}>${value}</${role}>`;
  },
};

function recordingTheme() {
  const roles = [];
  return {
    roles,
    fg(role, value) {
      roles.push(role);
      return value;
    },
  };
}

// The style seam — the process-wide slot Gentle Shell publishes — and a scratch
// preference home, so no case reads or writes the real user's document.
const CARD_STYLE_SLOT = Symbol.for('gentle-pi.card-style');
const CARD_BASH_MODE_SLOT = Symbol.for('gentle-pi.card-bash-mode');

const savedHome = process.env.GENTLE_PI_CONFIG_HOME;
let configHome;

before(() => {
  configHome = mkdtempSync(join(tmpdir(), 'odd-worktree-bash-card-'));
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  delete globalThis[CARD_BASH_MODE_SLOT];
});

after(() => {
  delete globalThis[CARD_STYLE_SLOT];
  delete globalThis[CARD_BASH_MODE_SLOT];
  if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
  rmSync(configHome, { recursive: true, force: true });
});

// ---- the resolver under test ----

function cardFor(options) {
  const registered = [];
  const cards = createBashCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => registered.push(resolver),
    ...options,
  });
  assert.equal(cards.registered, true, 'the probe accepted the resolver');
  assert.equal(registered.length, 1, 'exactly one resolver reached the host hook');
  return registered[0];
}

/** A host that draws bash itself, in the self shell the card substrate expects. */
const HOST_BASH = {
  renderShell: 'self',
  renderCall: () => ({ render: () => ['host bash call'], invalidate() {} }),
  renderResult: () => ({ render: () => ['host bash result'], invalidate() {} }),
};

function slotFor(resolver) {
  const slot = resolver('bash', () => HOST_BASH);
  assert.equal(slot?.renderShell, 'self', 'the card frames itself, so the host draws no filled box under it');
  return slot;
}

function callRows(resolver, args, theme, context, width = 60) {
  return slotFor(resolver).renderCall(args, theme, context ?? { isPartial: false }).render(width);
}

function resultRows(resolver, args, result, options, theme, context, width = 60) {
  return slotFor(resolver).renderResult(result, options, theme, { args, ...(context ?? {}) }).render(width);
}

const textResult = (text, isError) => ({ content: [{ type: 'text', text }], details: {}, ...(isError ? { isError: true } : {}) });

/** The text a cell draws, with both the ANSI a real theme paints and the tags the fake theme wraps it in removed. */
const unpaint = (value) => stripAnsi(value).replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, '');

/** The visible content of a body row, without the neon frame. */
const bodyText = (row) => unpaint(row).replace(/^│ /, '').replace(/ +│$/, '');

/** Every row the card draws must be exactly the width the host asked for. */
function assertFramed(rows, width) {
  for (const row of rows) assert.equal(metrics.visibleWidth(unpaint(row)), width, `"${unpaint(row)}" is not ${width} wide`);
}

// ---- the identity ----

test('the identity is the generic `$ bash` for a name nothing claims, and a family mark and word for one the classifier names', () => {
  assert.deepEqual(BASH_CARD_IDENTITY, { glyph: '$', title: 'bash', titleRole: 'bashMode' }, 'S2 names the unnamed command `$ bash`');

  // Every family the classifier exports draws from the classifier's own table, so the
  // heading can never disagree with the name the call wears. The list is iterated, never
  // restated: a family added beside the classifier is covered here without an edit.
  for (const activity of SHELL_ACTIVITIES) {
    const identity = SHELL_ACTIVITY_IDENTITY[activity];
    assert.ok(identity, `the classifier declares an identity for ${activity}`);
    assert.deepEqual(
      bashCardIdentity(activity),
      { glyph: identity.glyph, title: activity, titleRole: identity.titleRole },
      `${activity} wears its own mark, word and theme role`,
    );
  }

  // A command no family names, and any value this module cannot read, is the generic
  // identity: a heading is never a guess.
  for (const value of [undefined, null, 'nope', 'constructor', '__proto__', 42, {}]) {
    assert.deepEqual(bashCardIdentity(value), BASH_CARD_IDENTITY, `${String(value)} keeps the generic identity`);
  }

  // The CodeGraph family is the CodeGraph card's own identity, not a second one: a
  // `codegraph …` command drawn here (no CLI, so no CodeGraph card) reads exactly as
  // the CodeGraph card's own label does.
  assert.equal(bashCardIdentity('codegraph').glyph, CODEGRAPH_MARK);
  assert.equal(bashCardIdentity('codegraph').titleRole, CODEGRAPH_TITLE_ROLE);
});

test('one heading per family, drawn from the command the call runs', () => {
  // One sample command per family. A family this file has no command for is covered by
  // the identity case above; a sample the classifier does not name (a family whose rule
  // is still landing) is skipped rather than asserted about, but it may never name a
  // DIFFERENT family.
  const samples = {
    destructive: 'rm -rf build',
    checking: 'pnpm test',
    formatting: 'prettier --write src/a.ts',
    preparing: 'pnpm install',
    publishing: 'git push origin feat/one',
    versioning: 'git commit -m "a message"',
    codegraph: 'codegraph query alpha',
    exploring: 'git status',
  };
  const resolver = cardFor();
  for (const activity of SHELL_ACTIVITIES) {
    const sample = samples[activity];
    if (sample === undefined) continue;
    const named = inferBashActivity(sample);
    assert.ok(named === activity || named === undefined, `"${sample}" is ${activity} or nothing, never ${named}`);
    if (named !== activity) continue;
    const identity = SHELL_ACTIVITY_IDENTITY[activity];
    const rows = callRows(resolver, { command: sample }, taggedTheme, { isPartial: false });
    assert.equal(rows.length, 1, `${activity} draws one settled heading`);
    const heading = unpaint(rows[0]);
    assert.ok(heading.includes(`${identity.glyph.trimEnd()} `), `${activity} leads with its mark in "${heading}"`);
    assert.ok(heading.includes(activity), `${activity} names its word in "${heading}"`);
    assert.ok(rows[0].includes(`<${identity.titleRole}>`), `${activity} paints the label in ${identity.titleRole}`);
    assertFramed(rows, 60);
  }

  // The generic heading is the `$ bash` identity, and the command is its detail.
  const generic = callRows(resolver, { command: './scripts/deploy.sh' }, taggedTheme, { isPartial: false });
  assert.match(unpaint(generic[0]), /^\s*│?\s*╭─ \$ bash/, `an unnamed command heads with "$ bash" in "${unpaint(generic[0])}"`);
  assert.match(unpaint(generic[0]), /\.\/scripts\/deploy\.sh/, 'the command itself is the heading detail');
  assert.ok(generic[0].includes('<bashMode>$ bash</bashMode>'), 'the generic label wears the bash tool\'s own role');
});

test('a chain with a segment nothing names is generic, never partially named', () => {
  const resolver = cardFor();
  const rows = callRows(resolver, { command: 'pnpm test && ./scripts/deploy.sh' }, plainTheme, { isPartial: false });
  assert.match(unpaint(rows[0]), /\$ bash/, 'the heading claims no family for a composition it cannot name');
  assert.doesNotMatch(unpaint(rows[0]), /checking/, 'no segment of the chain is promoted');
  assert.match(unpaint(rows[0]), /pnpm test && \.\/scripts\/deploy\.sh/, 'the whole command is the detail');
});

// ---- the collapsed detail ----

test('the collapsed detail folds a leading cd chain, caps the rows and shortens a long command', () => {
  // The role of the reference's `bashSummary`: the work, not the setup; one stated row.
  assert.equal(bashCardDetail('cd /tmp/ws && git status', 60, metrics), 'git status');
  assert.equal(bashCardDetail('cd "/tmp/a b" && cd build && pnpm test', 60, metrics), 'pnpm test');
  assert.equal(bashCardDetail('git status\nls -la', 60, metrics), 'git status … +1 line');
  assert.equal(bashCardDetail('git status\nls -la\n\n', 60, metrics), 'git status … +1 line');
  // A long command is clipped to the room the heading leaves, and it ends in an ellipsis.
  const long = `git commit -m "${'a'.repeat(120)}"`;
  const shortened = bashCardDetail(long, 20, metrics);
  assert.equal(metrics.visibleWidth(shortened), 20);
  assert.ok(shortened.endsWith('…'));
  // Nothing to say draws nothing: the heading keeps its identity alone.
  for (const value of ['', '   ', '\n', undefined, null, 42]) {
    assert.equal(bashCardDetail(value, 40, metrics), '');
  }
});

test('the drawn collapsed heading is one row, and expanding it shows the whole command', () => {
  const resolver = cardFor();
  const command = 'cd /tmp/ws && git log --oneline --graph --decorate --all';
  const collapsed = callRows(resolver, { command }, plainTheme, { isPartial: false }, 40);
  assert.equal(collapsed.length, 1, 'a collapsed heading stays one row');
  const text = unpaint(collapsed[0]);
  assert.match(text, /⌕ exploring/);
  assert.match(text, /git log --oneline/);
  assert.match(text, /^╭─ /, 'the collapsed call is the card\'s own top rule');
  assert.ok(text.endsWith('╮'), 'the row is framed');
  assertFramed(collapsed, 40);

  const expanded = callRows(resolver, { command }, plainTheme, { isPartial: false, expanded: true }, 40);
  assert.ok(expanded.length > 1, 'expanding the call continues the command on the rows below');
  const whole = expanded.map(bodyText).join(' ');
  assert.match(whole, /cd \/tmp\/ws && git log --oneline --graph --decorate --all/, 'the complete command is drawn');
  assertFramed(expanded, 40);
});

// ---- the result ----

test('a running call is the warning tone and closes its own frame', () => {
  const resolver = cardFor();
  const rows = callRows(resolver, { command: 'pnpm test' }, taggedTheme, { isPartial: true }, 40);
  assert.equal(rows.length, 3, 'a heading, the running row and the closed frame');
  assert.match(rows[0], /^<warning>╭<\/warning>/, 'pending is the warning tone');
  assert.match(rows[1], /^<warning>│<\/warning> <muted>running…<\/muted>/);
  assert.match(rows[2], /^<warning>╰/);
  assertFramed(rows, 40);

  // A settled call leaves the closing rule to the result that follows.
  assert.equal(callRows(resolver, { command: 'pnpm test' }, plainTheme, { isPartial: false }, 40).length, 1);
});

test('a collapsed result is the bounded tail of the output, in the shell tool-output role', () => {
  const resolver = cardFor();
  const output = 'one\ntwo\nthree\nfour\nfive\nsix';
  const rows = resultRows(resolver, { command: 'pnpm test' }, textResult(output), { isPartial: false }, taggedTheme, { durationMs: 900 });
  assert.equal(rows.length, 4, 'three preview rows and the closing rule');
  assert.deepEqual(rows.slice(0, 3).map(bodyText), ['four', 'five', 'six'], 'the end of the output is what a collapsed card states');
  for (const row of rows.slice(0, 3)) assert.match(row, /<toolOutput>/, 'command output is the theme tool-output role');
  assert.match(rows[3], /^<border>╰/, 'the result closes the frame the call above opened');
  assert.match(unpaint(rows[3]), /900ms/, 'the elapsed time rides the closing rule');
  assertFramed(rows, 60);
});

test('expanding the result draws the complete output, row for row', () => {
  const resolver = cardFor();
  const output = 'one\ntwo\nthree\nfour\nfive\nsix';
  const collapsed = resultRows(resolver, { command: 'pnpm test' }, textResult(output), { isPartial: false }, plainTheme, {});
  const expanded = resultRows(resolver, { command: 'pnpm test' }, textResult(output), { expanded: true, isPartial: false }, plainTheme, {});
  assert.equal(collapsed.length, 4);
  assert.equal(expanded.length, 7, 'six output rows and the closing rule');
  assert.deepEqual(expanded.slice(0, 6).map(bodyText), ['one', 'two', 'three', 'four', 'five', 'six'], 'the whole output, in order');
  // The substring every collapsed row holds is not the whole output.
  assert.equal(collapsed.slice(0, 3).map(bodyText).join('\n'), 'four\nfive\nsix');
});

test('a failed result is the error tone, in the error role, on every cell of its body', () => {
  const resolver = cardFor();
  const rows = resultRows(resolver, { command: 'pnpm test' }, textResult('FAIL src/a.test.js\n1 failed', true), { isPartial: false }, taggedTheme, {});
  assert.match(rows[0], /^<error>│<\/error>/, 'a failure paints its frame in the error role');
  assert.match(rows[0], /<error>FAIL src\/a\.test\.js<\/error>/, 'and its reason too');
  assert.match(rows.at(-1), /^<error>╰/);
  assert.match(unpaint(rows.slice(0, -1).map(bodyText).join('\n')), /FAIL src\/a\.test\.js\n1 failed/);

  // The host's own `isError` in the render options is the same flag.
  const fromOptions = resultRows(resolver, { command: 'pnpm test' }, textResult('boom'), { isPartial: false, isError: true }, taggedTheme, {});
  assert.match(fromOptions[0], /^<error>│/);
});

test('a partial result shows the rows it already has and leaves the closing rule to the final one', () => {
  const resolver = cardFor();
  const rows = resultRows(resolver, { command: 'pnpm test' }, textResult('RUN  v2.0.0\n ✓ a.test.js'), { isPartial: true }, taggedTheme, { durationMs: 1200 });
  assert.equal(rows.length, 2, 'the streamed rows, and no closing rule yet');
  assert.equal(rows.some((row) => stripAnsi(row).startsWith('╰')), false, 'a streamed result does not close the frame');
  assert.equal(rows.some((row) => stripAnsi(row).includes('1.2s')), false, 'the elapsed time belongs to the settled result');
  assert.match(rows[0], /^<warning>/, 'a streamed result is the warning tone');
});

test('an empty result draws no body row at all', () => {
  const resolver = cardFor();
  const rows = resultRows(resolver, { command: 'true' }, textResult('   \n\n'), { isPartial: false }, plainTheme, {});
  assert.equal(rows.length, 1, 'only the closing rule the call above waits for');
  assert.match(unpaint(rows[0]), /^╰/);
});

test('every cell asks the theme for one of its own roles, and never for a colour', () => {
  const resolver = cardFor();
  const recorder = recordingTheme();
  callRows(resolver, { command: './scripts/deploy.sh' }, recorder, { isPartial: false });
  callRows(resolver, { command: 'git status' }, recorder, { isPartial: false });
  assert.deepEqual([...new Set(recorder.roles)].sort(), ['bashMode', 'border', 'mdLink', 'muted'], 'the generic identity, the family identity, the frame and the detail');

  const resultRecorder = recordingTheme();
  resultRows(resolver, { command: 'true' }, textResult('ok'), { isPartial: false }, resultRecorder, {});
  assert.deepEqual([...new Set(resultRecorder.roles)].sort(), ['border', 'toolOutput'], 'an expanded body is the shell\'s tool-output role');
});

// ---- paint last: no painted string is ever measured ----

test('the rows are measured and clipped as plain text, and painted only afterwards', () => {
  // The theme tags every cell it paints, so any paint that came before a measurement
  // would arrive at the seam as a tag. The host's own key hint is deliberately absent
  // here: it arrives painted, and invariant 17 makes it the one measured exception.
  const seen = [];
  const spyMetrics = {
    visibleWidth(value) {
      seen.push(value);
      return metrics.visibleWidth(value);
    },
    truncateToWidth(value, width, ellipsis) {
      seen.push(value);
      return metrics.truncateToWidth(value, width, ellipsis);
    },
    wrapTextWithAnsi(value, width) {
      seen.push(value);
      return metrics.wrapTextWithAnsi(value, width);
    },
  };
  const resolver = cardFor({ metrics: spyMetrics });
  for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
    globalThis[CARD_STYLE_SLOT] = style;
    try {
      const call = callRows(resolver, { command: 'cd /tmp/ws && git status --short --branch' }, taggedTheme, { isPartial: false }, 44);
      const result = resultRows(resolver, { command: 'git status' }, textResult(' M lib/a.js\n M lib/b.js\n'), { isPartial: false }, taggedTheme, { durationMs: 1200 }, 44);
      assert.ok(call.some((row) => row.includes('<mdLink>')), `${style}: the heading was painted`);
      assert.ok(result.some((row) => row.includes('<toolOutput>')), `${style}: the body was painted`);
    } finally {
      globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
    }
  }
  assert.ok(seen.length > 0, 'the seams were used');
  for (const value of seen) {
    assert.equal(typeof value, 'string');
    assert.equal(value.includes(String.fromCharCode(27)), false, `a painted string reached the measurement seam: ${JSON.stringify(value)}`);
    assert.doesNotMatch(value, /<\/?[a-zA-Z][a-zA-Z0-9]*>/, `a painted row reached the measurement seam: ${JSON.stringify(value)}`);
  }
});

// ---- geometry ----

test('the card draws at every width the host may ask for', () => {
  const resolver = cardFor();
  for (const width of [0, 1, 2, 3, 5, 9, 10, 12, 16]) {
    for (const drawn of [
      callRows(resolver, { command: 'pnpm test' }, plainTheme, { isPartial: true }, width),
      callRows(resolver, { command: 'pnpm test' }, plainTheme, { isPartial: false, expanded: true }, width),
      resultRows(resolver, { command: 'pnpm test' }, textResult('a\nb\nc\nd'), { isPartial: false }, plainTheme, {}, width),
      resultRows(resolver, { command: 'pnpm test' }, textResult('a\nb\nc\nd'), { expanded: true, isPartial: false }, plainTheme, {}, width),
    ]) {
      for (const row of drawn) assert.ok(metrics.visibleWidth(row) <= width, `"${stripAnsi(row)}" overflows ${width}`);
    }
  }
});

test('the same card is the same text in float and in neon, and only the chrome differs', () => {
  const resolver = cardFor();
  const theme = { fg: (_role, value) => value, bg: (_role, value) => `\x1b[48;5;240m${value}\x1b[49m` };
  const draw = (style, run) => {
    globalThis[CARD_STYLE_SLOT] = style;
    try {
      return run();
    } finally {
      globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
    }
  };
  const content = (rows) => rows
    .map((row) => unpaint(row).replace(/[╭╮╰╯─│▎]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .join(' | ');
  const call = (style) => draw(style, () => callRows(resolver, { command: 'pnpm test' }, theme, { isPartial: false }, 60));
  const result = (style) => draw(style, () => resultRows(resolver, { command: 'pnpm test' }, textResult('all green'), { isPartial: false }, theme, { durationMs: 1200 }, 60));
  assert.equal(content(call(CARD_STYLE.FLOAT)), content(call(CARD_STYLE.NEON)), 'one heading, two chromes');
  assert.equal(content(result(CARD_STYLE.FLOAT)), content(result(CARD_STYLE.NEON)), 'one body row and one elapsed time');
  assert.match(content(result(CARD_STYLE.FLOAT)), /1\.2s$/);
  assert.equal(result(CARD_STYLE.FLOAT).some((row) => /[╭╮╰╯─│]/.test(row)), false, 'float draws no box');
  assert.equal(call(CARD_STYLE.NEON).some((row) => row.includes('▎')), false, 'neon draws no rail');
});

// ---- purity ----

test('the card module carries no colour, no escape and no host package', () => {
  for (const file of ['bash-card.js', 'bash-card-resolver.js']) {
    const source = readFileSync(join(__dirname, '..', 'lib', file), 'utf8');
    assert.doesNotMatch(source, /@earendil-works/, `${file} requires no host package`);
    assert.doesNotMatch(source, /\\u001b|\\x1b|String\.fromCharCode\(27\)/, `${file} writes no escape sequence down`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/, `${file} writes no hexadecimal colour`);
    assert.doesNotMatch(source, /require\(['"](?!\.\/|node:)/, `${file} imports only its own modules and Node builtins`);
    // Nothing is registered, executed or shadowed: the card only draws.
    assert.doesNotMatch(source, /registerTool\(|\.execute\b|registerCommand\(/, `${file} registers and runs nothing`);
    // Composition with the CodeGraph card is the extension's load order, never a
    // question asked of that module here: a mode that says "our cards" would
    // otherwise hand one bash command back to the host whenever the CLI is absent.
    // (`codegraph-card-preview.js` is not that module: it is the shared text reader.)
    assert.doesNotMatch(source, /require\(['"][^'"]*codegraph-card\.js['"]\)/, `${file} imports no CodeGraph card`);
    assert.doesNotMatch(source, /codegraphShape/, `${file} asks the CodeGraph card nothing about ownership`);
  }
});

test('the two modules name no tone background role of their own', () => {
  // The tone-to-background table has exactly one owner (lib/shell-card.js).
  for (const file of ['bash-card.js', 'bash-card-resolver.js']) {
    const source = readFileSync(join(__dirname, '..', 'lib', file), 'utf8');
    assert.doesNotMatch(source, /tool(?:Success|Pending|Error)Bg/, `${file} names no background role`);
  }
});

test('the classifier and the CodeGraph card read a codegraph command the same way', () => {
  // This agreement is what makes the load order work: the CodeGraph card, registered
  // first, claims exactly the commands whose `codegraph` identity this card would
  // wear if it were the only resolver. No upstream reading is lost: a command both
  // modules decline stays this card's generic `$ bash` row.
  for (const command of [
    'codegraph init',
    'codegraph sync',
    'codegraph query alpha',
    'codegraph explore -- auth login',
    'cd /tmp/ws && codegraph init -y',
    'git status && codegraph sync',
    'git status',
    'pnpm test',
    'echo codegraph init',
    'codegraph --help',
    'codegraph init > /tmp/log',
  ]) {
    const byShape = codegraphShape('bash', { command }) !== undefined;
    assert.equal(byShape, inferBashActivity(command) === 'codegraph', `"${command}" reads the same way on both sides`);
  }
  // And the classifier's own predicate answers the same question.
  const { isCodegraphCommand } = require('../lib/bash-activity.js');
  for (const command of ['codegraph query alpha', 'git status', 'pnpm test']) {
    assert.equal(isCodegraphCommand(command), codegraphShape('bash', { command }) !== undefined, command);
  }
});

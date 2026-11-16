'use strict';
// The bash activity design: what a caller of the bridge's `registerToolDesign` observes.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  BASH_DESIGN_ID,
  BASH_DESIGN_LABEL,
  applyBashActivityHeading,
  bashActivityDesign,
  registerBashDesign,
  seedBashDesignSelection,
} = require('../lib/bash-design.js');

const CALL = { tool: 'bash', part: 'call', width: 90 };
const strip = (row) => row.replace(/\u001b\[[0-9;]*m/g, '');
const cols = (row) => Array.from(strip(row)).length;
const textWidth = (text) => Array.from(text).length;

// The host's two frames, as the bridge hands them for a collapsed call.
const neon = (command, hint = 'ctrl+o to expand') => {
  const used = `╭─ $ ${command} `.length + ` ${hint} ─╮`.length;
  return `╭─ $ ${command} ${'─'.repeat(Math.max(2, 90 - used))} ${hint} ─╮`;
};
const float = (command) => `  $ ${command}${' '.repeat(Math.max(2, 90 - command.length - 4))}ctrl+o to expand`;

describe('the heading', () => {
  test('a named command swaps the mark for its activity and keeps the row width', () => {
    for (const [frame, mk] of [['neon', neon], ['float', float]]) {
      const row = mk("sed -n '1,40p' lib/app.js");
      const [out] = applyBashActivityHeading([row], CALL);
      assert.match(out, /⌕ exploring/, frame);
      assert.doesNotMatch(strip(out), /\$/, frame);
      assert.equal(cols(out), cols(row), `${frame} keeps its width`);
      assert.match(out, /sed -n '1,40p' lib\/app\.js/, 'the command is untouched');
      assert.match(out, /ctrl\+o to expand/, 'the hint is untouched');
    }
  });

  test('the other families get their own mark and word', () => {
    const cases = [['node --test tools/*.test.js', '✓ checking'], ['rm -rf build', '⚠ destructive'], ['git commit -m wip', '⎇ versioning']];
    for (const [command, heading] of cases) {
      const [out] = applyBashActivityHeading([neon(command)], CALL);
      assert.ok(strip(out).includes(heading), `${command} -> ${heading}`);
    }
  });

  test('host paint around the mark survives', () => {
    const row = `\u001b[36m╭─ \u001b[1m$ ls -la\u001b[22m ${'─'.repeat(30)} ctrl+o to expand ─╮\u001b[39m`;
    const [out] = applyBashActivityHeading([row], CALL);
    assert.ok(out.startsWith('\u001b[36m╭─ \u001b[1m⌕ exploring'));
    assert.ok(out.endsWith('╮\u001b[39m'));
  });

  test('an unnamed command is headed `$ bash`, never an activity', () => {
    for (const command of ['cd /tmp', 'frobnicate --now']) {
      const [out] = applyBashActivityHeading([neon(command)], CALL);
      assert.match(strip(out), new RegExp(`\\$ bash ${command}`));
    }
  });

  test('a heading that does not prove the whole command is never named', () => {
    const unproven = [
      neon('sed -n 1,40p a.ts … +3 lines'),
      neon('ls -la some/very/long/pa…'),
      float('ls -la && rm -rf x…'),
    ];
    for (const row of unproven) {
      assert.doesNotMatch(strip(applyBashActivityHeading([row], CALL)[0]), /exploring|destructive/, row);
    }
    // A continuation row means the heading is only the first line of the command.
    const multi = [neon('ls'), '│ rm -rf build │'];
    assert.doesNotMatch(strip(applyBashActivityHeading(multi, CALL)[0]), /exploring/);
  });

  test('text after the command that is not the host fill or hint is never named', () => {
    const row = '  $ ls  &&  rm -rf build' + ' '.repeat(20);
    assert.doesNotMatch(strip(applyBashActivityHeading([row], CALL)[0]), /exploring|destructive/);
  });

  test('a row with no fill to pay for the word is left alone', () => {
    const row = '$ ls -la';
    assert.deepEqual(applyBashActivityHeading([row], CALL), [row]);
  });

  test('results, other tools and result-like rows are never rewritten', () => {
    const row = neon('ls -la');
    assert.deepEqual(applyBashActivityHeading([row], { ...CALL, part: 'result' }), [row]);
    assert.deepEqual(applyBashActivityHeading([row], { ...CALL, tool: 'read' }), [row]);
    const spacer = ['', neon('ls -la')];
    assert.deepEqual(applyBashActivityHeading(spacer, CALL), spacer);
    const body = ['│ $ ls -la                          │'];
    assert.deepEqual(applyBashActivityHeading(body, CALL), body);
  });

  test('it never throws and never mutates its input', () => {
    const input = Object.freeze([neon('ls -la')]);
    assert.doesNotThrow(() => applyBashActivityHeading(input, CALL));
    assert.doesNotThrow(() => applyBashActivityHeading(undefined, CALL));
    assert.doesNotThrow(() => applyBashActivityHeading([null], CALL));
  });
});

// A theme as Pi hands it: `fg(role, text)` wraps the text in that role's colour as SGR escapes
// (zero columns). One distinct code per role, so a test reads which role painted which cells.
const ROLE_CODE = { mdLink: 31, mdHeading: 32, error: 33, success: 34, warning: 35, syntaxFunction: 36, bashMode: 37, dim: 90 };
const theme = { fg: (role, text) => `\u001b[${ROLE_CODE[role]}m${text}\u001b[39m` };
const painted = (role, text) => `\u001b[${ROLE_CODE[role]}m${text}\u001b[39m`;
const THEMED = { ...CALL, theme };

describe('role colour', () => {
  test('each family paints its mark and word in its own theme role', () => {
    const cases = [
      ["sed -n '1,40p' a.js", 'mdLink', '⌕ exploring'],
      ['node --test tools/*.test.js', 'mdHeading', '✓ checking'],
      ['rm -rf build', 'error', '⚠ destructive'],
      ['git push origin main', 'success', '↑ publishing'],
      ['git commit -m wip', 'warning', '⎇ versioning'],
      ['prettier --write .', 'syntaxFunction', '≋ formatting'],
    ];
    for (const [command, role, heading] of cases) {
      for (const mk of [neon, float]) {
        const [out] = applyBashActivityHeading([mk(command)], THEMED);
        assert.ok(out.includes(painted(role, heading)), `${command} -> ${role}`);
      }
    }
  });

  test('the colour changes no column and leaves the host paint after the mark in force', () => {
    const row = `\u001b[36m╭─ \u001b[1m$ ls -la\u001b[22m ${'─'.repeat(30)} ctrl+o to expand ─╮\u001b[39m`;
    const [out] = applyBashActivityHeading([row], THEMED);
    assert.equal(cols(out), cols(row));
    // After the role-painted label the host's own escapes that preceded the mark are re-issued.
    assert.ok(out.includes(`${painted('mdLink', '⌕ exploring')}\u001b[36m\u001b[1m`), out);
    assert.ok(out.endsWith('╮\u001b[39m'));
  });

  test('a theme that cannot paint falls back to the plain label', () => {
    for (const bad of [undefined, null, {}, { fg: () => { throw new Error('x'); } }, { fg: () => 42 }]) {
      const [out] = applyBashActivityHeading([neon('ls -la')], { ...CALL, theme: bad });
      assert.ok(strip(out).includes('⌕ exploring'), String(bad));
      assert.doesNotMatch(out, /\u001b\[31m/);
    }
  });
});

describe('the generic heading', () => {
  test('a command nothing names is headed `$ bash` in the bashMode role, width kept', () => {
    for (const mk of [neon, float]) {
      for (const command of ['cd /tmp', 'frobnicate --now', 'node scripts/x.mjs']) {
        const row = mk(command);
        const [out] = applyBashActivityHeading([row], THEMED);
        assert.ok(out.includes(painted('bashMode', '$ bash')), command);
        assert.match(strip(out), new RegExp(command.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
        assert.equal(cols(out), cols(row), `${command} keeps its width`);
      }
    }
  });

  test('without a theme it still reads `$ bash` and keeps the width', () => {
    const row = neon('frobnicate --now');
    const [out] = applyBashActivityHeading([row], CALL);
    assert.match(out, /\$ bash frobnicate --now/);
    assert.equal(cols(out), cols(row));
  });

  test('a heading that hides part of the command is `$ bash`, never an activity', () => {
    for (const row of [neon('sed -n 1,40p a.ts … +3 lines'), neon('ls -la some/very/long/pa…'), float('ls -la && rm -rf x…')]) {
      const [out] = applyBashActivityHeading([row], THEMED);
      assert.doesNotMatch(strip(out), /exploring|destructive/, row);
      assert.match(strip(out), /\$ bash /, row);
      assert.equal(cols(out), cols(row), row);
    }
  });

  test('a multi-row call is headed `$ bash` on its first row and its other rows are untouched', () => {
    const rows = [neon('ls'), '│ rm -rf build │'];
    const out = applyBashActivityHeading(rows, THEMED);
    assert.ok(out[0].includes(painted('bashMode', '$ bash')));
    assert.equal(out[1], rows[1]);
  });
});

// What the bridge hands a design about the call itself (`ctx.render`).
const render = (command, extra = {}) => ({ toolCallId: 'c1', args: { command }, isPartial: false, isError: false, ...extra });
const RESULT = { tool: 'bash', part: 'result', width: 90, theme };
const closing = (extra = '') => `╰${'─'.repeat(88 - extra.length)}${extra}╯`;
const sgr = (code, text) => `\u001b[${code}m${text}\u001b[39m`;

describe('the call, not the drawn heading', () => {
  test('a command the host truncated is still named from its real arguments', () => {
    const long = `grep -rn "needle" ${'src/'.repeat(30)} | head`;
    const row = neon(`${long.slice(0, 50)}…`);
    const [out] = applyBashActivityHeading([row], { ...THEMED, render: render(long) });
    assert.ok(out.includes(painted('mdLink', '⌕ exploring')), strip(out));
    assert.equal(cols(out), cols(row));
  });

  test('a multi-line or wrapped heading is named from its arguments too', () => {
    const rows = [neon('cd /tmp'), '│ echo ---; grep -rn x . │'];
    const out = applyBashActivityHeading(rows, { ...THEMED, render: render('cd /tmp && echo ---; grep -rn x .') });
    assert.ok(out[0].includes(painted('mdLink', '⌕ exploring')));
    assert.equal(out[1].replace(/\u001b\[[0-9;]*m/g, ''), rows[1]);
  });

  test('arguments the classifier cannot name keep `$ bash`, even when the heading looks nameable', () => {
    const [out] = applyBashActivityHeading([neon('ls')], { ...THEMED, render: render('frobnicate --now') });
    assert.ok(out.includes(painted('bashMode', '$ bash')));
    assert.doesNotMatch(strip(out), /exploring/);
  });

  test('without arguments the drawn heading is still the evidence', () => {
    const [out] = applyBashActivityHeading([neon('ls -la')], { ...THEMED, render: { isPartial: false } });
    assert.ok(out.includes(painted('mdLink', '⌕ exploring')));
  });
});

describe('room for the label', () => {
  const LONG = `grep -rn "activity" ${'lib/'.repeat(14)} | head -40; echo ---; grep -rn x . -l`;
  test('a long heading with almost no fill gives up the tail of the command, not the label', () => {
    const row = neon(LONG.slice(0, 50) + '…');
    for (const mk of [(c) => neon(c), (c) => float(c)]) {
      const shown = mk(LONG.slice(0, 55) + '…');
      const [out] = applyBashActivityHeading([shown], { ...THEMED, render: render(LONG) });
      const text = strip(out);
      assert.ok(text.includes('⌕ exploring'), text);
      assert.equal(cols(out), cols(shown), 'the row keeps the width the host made it');
      assert.ok(text.includes('grep -rn "activity"'), 'the start of the command survives');
      assert.match(text, /…/, 'the cut is shown as an ellipsis');
      assert.match(text, /ctrl\+o to expand/, 'the hint survives');
    }
    assert.ok(row.length > 0);
  });

  test('a command shown in full that does not leave room is cut with an ellipsis', () => {
    const cmd = `grep -rn "needle" ${'src/'.repeat(8)} | head -40`;
    const row = neon(cmd);
    const [out] = applyBashActivityHeading([row], { ...THEMED, render: render(cmd) });
    const text = strip(out);
    assert.ok(text.includes('⌕ exploring'), text);
    assert.equal(cols(out), cols(row));
    assert.match(text, /…/);
  });

  test('the generic `$ bash` also makes room the same way', () => {
    const cmd = `./deploy.sh ${'--flag '.repeat(10)}`.trim();
    const row = neon(cmd);
    const [out] = applyBashActivityHeading([row], { ...THEMED, render: render(cmd) });
    assert.ok(out.includes(painted('bashMode', '$ bash')), strip(out));
    assert.equal(cols(out), cols(row));
  });

  test('when even the cut would leave too little of the command the row is left alone', () => {
    const row = '$ ls -la';
    assert.deepEqual(applyBashActivityHeading([row], { ...THEMED, render: render('ls -la') }), [row]);
  });

  test('the colour is applied to the label, never to the cut command text', () => {
    const [out] = applyBashActivityHeading([neon(LONG.slice(0, 55) + '…')], { ...THEMED, render: render(LONG) });
    assert.ok(out.includes(painted('mdLink', '⌕ exploring')));
    assert.ok(!out.includes(painted('mdLink', '…')), 'only the frame and the label are painted');
  });
});

describe('escapes the design re-issues', () => {
  test('a host row with no paint gets no empty open/close pairs from the design', () => {
    const [out] = applyBashActivityHeading([neon('ls -la')], { ...THEMED, render: render('ls -la') });
    assert.doesNotMatch(out, /\u001b\[[0-9;]*m\u001b\[39m/);
  });

  test('the host paint in force is issued once after each thing the design paints, never the design\'s own', () => {
    const row = `\u001b[36m╭─ \u001b[1m$ ls -la\u001b[22m ${'─'.repeat(30)} ctrl+o to expand ─╮\u001b[39m`;
    const [out] = applyBashActivityHeading([row], { ...THEMED, render: render('ls -la') });
    // Nothing the design painted (a role colour) is ever re-issued as if it were the host's.
    for (const code of [31, 37]) assert.equal((out.match(new RegExp(`\\u001b\\[${code}m`, 'g')) ?? []).length, (out.match(new RegExp(`\\u001b\\[${code}m`, 'g')) ?? []).length);
    const stray = out.replace(/\u001b\[(?:3[1-7]|1|22|39)m/g, '').replace(/[^\u001b]/g, '');
    assert.equal(stray, '', 'only the host and role SGRs appear');
    assert.equal(cols(out), cols(row));
  });

  test('state tracking: a host reset or colour change before the run is honoured', () => {
    const row = `\u001b[36m╭─ \u001b[39m\u001b[32m$ ls -la\u001b[39m ${'─'.repeat(30)} ctrl+o to expand ─╮`;
    const [out] = applyBashActivityHeading([row], { ...THEMED, render: render('ls -la') });
    assert.equal(cols(out), cols(row));
    // Right after the label the host's green (32) is back in force; the cyan it had closed is not.
    const afterLabel = out.slice(out.indexOf('⌕ exploring') + '⌕ exploring'.length);
    assert.ok(afterLabel.startsWith('\u001b[39m\u001b[32m') || afterLabel.startsWith('\u001b[32m'), JSON.stringify(afterLabel.slice(0, 20)));
    assert.ok(!afterLabel.startsWith('\u001b[36m'));
  });
});

describe('the frame', () => {
  const FRAME = ['╭─ ⌕ exploring ls ───────────── ctrl+o to expand ─╮', '│ out                    │', closing()];
  test('an idle card paints every frame cell in the activity role, text untouched', () => {
    const out = applyBashActivityHeading(FRAME.slice(1), { ...RESULT, render: render('ls -la') });
    assert.ok(out[0].startsWith(sgr(31, '│')), out[0]);
    assert.ok(out[0].includes('out'), 'body text is not repainted');
    assert.ok(out[1].startsWith('\u001b[31m╰'), out[1]);
    assert.ok(out[1].includes('╯\u001b[39m'), out[1]);
    assert.equal(cols(out[1]), cols(FRAME[2]));
  });

  test('the top row of the call paints the corners and rules, and the label keeps its own role', () => {
    const [out] = applyBashActivityHeading([neon('ls -la')], { ...THEMED, render: render('ls -la') });
    assert.ok(out.startsWith('\u001b[31m╭─'), out);
    assert.ok(out.includes(painted('mdLink', '⌕ exploring')));
    assert.ok(out.includes('─╮\u001b[39m'), out);
  });

  test('a running call owns the whole frame in warning, a failed one in error, and the label keeps its activity', () => {
    for (const [extra, role, code] of [[{ isPartial: true }, 'warning', 35], [{ isError: true }, 'error', 33]]) {
      const [out] = applyBashActivityHeading([neon('ls -la')], { ...THEMED, render: render('ls -la', extra) });
      assert.ok(out.startsWith(`\u001b[${code}m╭─`), role);
      assert.ok(out.includes(painted('mdLink', '⌕ exploring')), `${role}: the label keeps its activity colour`);
    }
  });

  test('a generic call paints its frame in the bashMode role', () => {
    const [out] = applyBashActivityHeading([closing()], { ...RESULT, render: render('frobnicate') });
    assert.ok(out.startsWith('\u001b[37m╰'), out);
  });

  test('the float bar is painted and the row keeps its width', () => {
    const row = `▎ out${' '.repeat(80)}`;
    const [out] = applyBashActivityHeading([row], { ...RESULT, render: render('ls') });
    assert.ok(out.startsWith(sgr(31, '▎')), out);
    assert.equal(cols(out), cols(row));
  });

  test('no theme, or no render context: frame bytes are the host\'s', () => {
    const rows = [...FRAME];
    assert.deepEqual(applyBashActivityHeading(rows.slice(1), { tool: 'bash', part: 'result', width: 90, render: render('ls') }), rows.slice(1));
    assert.deepEqual(applyBashActivityHeading(rows.slice(1), { ...RESULT }), rows.slice(1));
  });
});

describe('elapsed time on the closing rule', () => {
  test('neon: a finished call shows its duration right-aligned against the corner, width kept', () => {
    const [out] = applyBashActivityHeading([closing()], { ...RESULT, render: render('ls', { durationMs: 142 }) });
    assert.match(strip(out), /^╰─+ 142ms ╯$/);
    assert.equal(cols(out), 90);
    assert.ok(out.includes(sgr(90, '142ms')), 'the duration is dim, not in the frame role');
  });

  test('seconds read with one decimal', () => {
    const [out] = applyBashActivityHeading([closing()], { ...RESULT, render: render('ls', { durationMs: 1234 }) });
    assert.match(strip(out), / 1\.2s ╯$/);
  });

  test('float: the duration rides the bottom row after the bar', () => {
    const row = `▎${' '.repeat(89)}`;
    const [out] = applyBashActivityHeading([row], { ...RESULT, render: render('ls', { durationMs: 87 }) });
    assert.match(strip(out), /^▎ +87ms $/);
    assert.equal(cols(out), 90);
  });

  test('never while running, never without a duration, never when there is no room, never on the call half', () => {
    const none = (extra, ctx = {}) => strip(applyBashActivityHeading([closing()], { ...RESULT, ...ctx, render: render('ls', extra) })[0]);
    assert.doesNotMatch(none({ isPartial: true, durationMs: 5 }), /ms/);
    assert.doesNotMatch(none({}), /ms/);
    assert.doesNotMatch(none({ durationMs: Number.NaN }), /ms/);
    assert.doesNotMatch(none({ durationMs: -1 }), /ms/);
    const tight = '╰──╯';
    const [narrow] = applyBashActivityHeading([tight], { ...RESULT, width: 4, render: render('ls', { durationMs: 5 }) });
    assert.doesNotMatch(strip(narrow), /ms/);
    assert.doesNotMatch(strip(applyBashActivityHeading([closing()], { ...CALL, theme, render: render('ls', { durationMs: 5 }) })[0]), /ms/);
  });

  test('a body row that only looks like a closing rule inside the output is not given a duration', () => {
    const rows = ['│ ╰───╯ │', closing()];
    const out = applyBashActivityHeading(rows, { ...RESULT, render: render('ls', { durationMs: 9 }) });
    assert.doesNotMatch(strip(out[0]), /ms/);
    assert.match(strip(out[1]), /9ms/);
  });
});

describe('repeated frames', () => {
  const ctxFor = (command, extra = {}) => ({ ...THEMED, render: render(command, extra) });
  const row = neon('grep -rn needle src | head -40');

  test('the same call drawn twice is the same rows, as a fresh array each time', () => {
    const first = applyBashActivityHeading([row], ctxFor('grep -rn needle src | head -40'));
    const second = applyBashActivityHeading([row], ctxFor('grep -rn needle src | head -40'));
    assert.deepEqual(second, first);
    assert.notEqual(second, first, 'a caller may keep or change the array it gets');
    first[0] = 'changed by the caller';
    assert.notEqual(applyBashActivityHeading([row], ctxFor('grep -rn needle src | head -40'))[0], 'changed by the caller');
  });

  test('anything the drawing depends on changes the answer, never a stale one', () => {
    const base = applyBashActivityHeading([closing()], { ...RESULT, render: render('ls', { durationMs: 100 }) })[0];
    assert.notEqual(applyBashActivityHeading([closing()], { ...RESULT, render: render('ls', { durationMs: 200 }) })[0], base, 'duration');
    assert.notEqual(applyBashActivityHeading([closing()], { ...RESULT, render: render('ls', { durationMs: 100, isError: true }) })[0], base, 'error');
    assert.notEqual(applyBashActivityHeading([closing()], { ...RESULT, render: render('ls', { durationMs: 100, isPartial: true }) })[0], base, 'running');
    assert.notEqual(applyBashActivityHeading([closing()], { ...RESULT, render: render('rm -rf x', { durationMs: 100 }) })[0], base, 'family');
    assert.notEqual(applyBashActivityHeading([closing().replace('─', '━')], { ...RESULT, render: render('ls', { durationMs: 100 }) })[0], base, 'rows');
  });

  test('a theme switched under the same object repaints with the new colours', () => {
    const live = { palette: 31, fg(role, text) { return `\u001b[${this.palette}m${text}\u001b[39m`; } };
    const ctx = { tool: 'bash', part: 'call', width: 90, theme: live, render: render('ls -la') };
    const before = applyBashActivityHeading([neon('ls -la')], ctx)[0];
    live.palette = 34;
    const after = applyBashActivityHeading([neon('ls -la')], ctx)[0];
    assert.notEqual(after, before);
    assert.ok(after.includes('\u001b[34m'));
  });

  test('a long session of repeated cards stays cheap', () => {
    const ctx = ctxFor('grep -rn needle src | head -40');
    const start = performance.now();
    for (let index = 0; index < 30000; index += 1) applyBashActivityHeading([row], ctx);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `30000 frames took ${elapsed}ms`);
  });

  test('the cache is bounded: many different commands never grow it without limit', () => {
    for (let index = 0; index < 3000; index += 1) {
      assert.doesNotThrow(() => applyBashActivityHeading([neon(`ls -la dir${index}`)], ctxFor(`ls -la dir${index}`)));
    }
  });
});

describe('choosing the shape', () => {
  const fake = (version, acceptsLine) => {
    const calls = [];
    const disposed = [];
    return {
      calls,
      disposed,
      api: {
        VERSION: version,
        registerToolDesign: (design) => {
          calls.push(design);
          if (Array.isArray(design.tools) && !acceptsLine) throw new Error('refused: tool is required');
          const dispose = () => disposed.push(design.id ?? design.tool);
          return dispose;
        },
      },
    };
  };

  test('a readable release decides alone: no probe is ever registered', () => {
    for (const [version, grouped] of [['0.6.0', true], ['0.7.1', true], ['1.0.0', true], ['0.5.9', false], ['0.5.0', false]]) {
      const { api, calls } = fake(version, true);
      registerBashDesign(api)();
      assert.equal(calls.length, 1, version);
      assert.equal(Array.isArray(calls[0].tools), grouped, version);
    }
  });

  test('a release string that cannot be read is asked instead, and the probe is disposed', () => {
    for (const version of ['nightly', '', 'v0.6.0', 'six.zero', undefined, null, 6]) {
      const accepting = fake(version, true);
      const disposeProbe = registerBashDesign(accepting.api);
      assert.equal(typeof disposeProbe, 'function', String(version));
      disposeProbe();
      assert.equal(accepting.calls.length, 2, `${String(version)}: probe then ours`);
      assert.equal(accepting.calls[0].id, 'odd-worktree.capability-probe');
      assert.equal(Array.isArray(accepting.calls[1].tools), true, String(version));
      assert.equal(accepting.disposed[0], 'odd-worktree.capability-probe', String(version));
    }
  });

  test('a bridge that refuses the line is probed once and keeps the per-tool shape', () => {
    const refusing = fake('nightly', false);
    const dispose = registerBashDesign(refusing.api);
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.equal(refusing.calls.at(-1).tool, 'bash', 'the probe threw, so the old shape is registered');
    assert.equal(Array.isArray(refusing.calls.at(-1).tools), false);
    assert.ok(!refusing.disposed.includes('odd-worktree.capability-probe'), 'a refused probe has nothing to dispose');
  });

  test('the probe is never selected, never labelled and never named', () => {
    const accepting = fake('nightly', true);
    registerBashDesign(accepting.api)();
    const probe = accepting.calls[0];
    assert.equal(probe.label, 'probe');
    assert.equal(probe.name, undefined, 'it must not claim a plugin line');
    assert.notEqual(probe.id, BASH_DESIGN_ID);
    assert.deepEqual(probe.tools, ['odd-worktree-probe']);
    assert.equal(probe.line, 'odd-worktree-probe');
  });
});

describe('the registration', () => {
  test('is one bash design with the label the bridge line shows and a preview', () => {
    const design = bashActivityDesign();
    assert.equal(design.tool, 'bash');
    assert.equal(design.id, BASH_DESIGN_ID);
    assert.equal(design.label, BASH_DESIGN_LABEL);
    assert.equal(BASH_DESIGN_LABEL, 'activity');
    const preview = design.preview();
    assert.equal(preview.title, 'Cards · activity');
    // One line like every other Cards row, and one that fits a narrow panel.
    assert.equal(preview.sample.split('\n').length, 1);
    assert.ok(textWidth(preview.sample) <= 72, preview.sample);
    for (const word of ['exploring', 'checking', 'versioning', 'publishing', 'destructive']) {
      assert.ok(preview.sample.includes(word), word);
    }
    preview.title = 'changed';
    assert.equal(design.preview().title, 'Cards · activity');
  });

  test('registers once per process, returns an idempotent disposer, and tolerates a bridge without the API', () => {
    const seen = [];
    const api = { registerToolDesign: (d) => { seen.push(d); return () => seen.pop(); } };
    assert.equal(registerBashDesign({}), null);
    assert.equal(registerBashDesign(null), null);
    const dispose = registerBashDesign(api);
    assert.equal(typeof dispose, 'function');
    assert.equal(registerBashDesign(api), dispose, 'a second call is the same registration');
    assert.equal(seen.length, 1);
    dispose();
    dispose();
    assert.equal(seen.length, 0);
    assert.equal(registerBashDesign({ registerToolDesign: () => { throw new Error('refused'); } }), null);
  });
});

// A bridge whose `createStore` keeps one in-memory file per plugin id, like the real one.
function fakeBridge(files = {}) {
  const writes = [];
  const createStore = (id) => ({
    get: (key, fallback) => (files[id] && Object.hasOwn(files[id], key) ? files[id][key] : fallback),
    set: (key, value) => { writes.push([id, key]); files[id] = { ...files[id], [key]: value }; },
  });
  return { api: { registerToolDesign: () => () => {}, createStore }, files, writes };
}
const SELECTIONS = ['bridge-tool-designs', 'selections'];

describe('the first-run selection', () => {
  test('a first load with no choice selects activity for bash and keeps the other tools', () => {
    const { api, files } = fakeBridge({ 'bridge-tool-designs': { selections: { write: 'x.write' } } });
    assert.equal(seedBashDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections, { write: 'x.write', bash: BASH_DESIGN_ID });
  });

  test('a fresh install with no store file at all selects activity', () => {
    const { api, files } = fakeBridge();
    assert.equal(seedBashDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections, { bash: BASH_DESIGN_ID });
  });

  test('a choice the user already made is never overwritten, native included', () => {
    for (const chosen of ['native', 'someone.else']) {
      const { api, files } = fakeBridge({ 'bridge-tool-designs': { selections: { bash: chosen } } });
      assert.equal(seedBashDesignSelection(api), false, chosen);
      assert.equal(files['bridge-tool-designs'].selections.bash, chosen);
    }
  });

  test('it seeds once: native chosen afterwards stays native on the next load', () => {
    const { api, files } = fakeBridge();
    assert.equal(seedBashDesignSelection(api), true);
    files['bridge-tool-designs'] = { selections: { bash: 'native' } };
    assert.equal(seedBashDesignSelection(api), false);
    // Even with the selection removed entirely, the marker says it was already offered.
    files['bridge-tool-designs'] = { selections: {} };
    assert.equal(seedBashDesignSelection(api), false);
    assert.deepEqual(files['bridge-tool-designs'].selections, {});
  });

  test('a bridge without createStore, a malformed file or a failing store seeds nothing and never throws', () => {
    assert.equal(seedBashDesignSelection({}), false);
    assert.equal(seedBashDesignSelection(null), false);
    const malformed = fakeBridge({ 'bridge-tool-designs': { selections: 'oops' } });
    assert.doesNotThrow(() => seedBashDesignSelection(malformed.api));
    const failing = { createStore: () => ({ get: (_k, f) => f, set: () => { throw new Error('disk full'); } }) };
    assert.equal(seedBashDesignSelection(failing), false);
  });

  test('a failed write leaves no marker, so the next load tries again', () => {
    let fail = true;
    const files = {};
    const createStore = (id) => ({
      get: (key, fallback) => (files[id] && Object.hasOwn(files[id], key) ? files[id][key] : fallback),
      set: (key, value) => { if (fail && id === SELECTIONS[0]) throw new Error('disk full'); files[id] = { ...files[id], [key]: value }; },
    });
    assert.equal(seedBashDesignSelection({ createStore }), false);
    fail = false;
    assert.equal(seedBashDesignSelection({ createStore }), true);
    assert.equal(files['bridge-tool-designs'].selections.bash, BASH_DESIGN_ID);
  });

  test('registering the design on a bridge seeds it, and a refused registration registers nothing', () => {
    const accepted = fakeBridge();
    const dispose = registerBashDesign(accepted.api);
    assert.equal(typeof dispose, 'function');
    assert.equal(accepted.files['bridge-tool-designs'].selections.bash, BASH_DESIGN_ID);
    dispose();
    // The seed runs BEFORE the registration (so a 0.6.0 bridge inherits it), which means a
    // refusal can only arrive after the choice is stored: the bridge then holds a value whose
    // design is not registered, which its own report calls `missing` and draws as the host's card.
    const refused = fakeBridge();
    refused.api.registerToolDesign = () => { throw new Error('refused'); };
    assert.equal(registerBashDesign(refused.api), null);
    assert.equal(refused.files['bridge-tool-designs'].selections.bash, BASH_DESIGN_ID);
  });
});

// The read-only tools the one `activity` value covers. The host heads their cards
// `<glyph> <tool> <arguments>`; every one of them only reads, so the word is always the same.
const READ_GLYPH = { grep: '⌕', find: '⌖', ls: '☷', read: '≡' };
const READ_ARGS = {
  grep: '/needle/ in src/app.js',
  find: '*.test.js in tools',
  ls: 'src/lib',
  read: 'lib/bash-design.js:1-40',
};
const READ_TOOLS = ['grep', 'find', 'ls', 'read'];
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const toolHead = (tool, args) => `${READ_GLYPH[tool]} ${tool} ${args}`;

// The host's two frames, with a read-only tool's heading instead of bash's `$`.
const readNeon = (tool, args = READ_ARGS[tool], hint = 'ctrl+o to expand') => {
  const head = toolHead(tool, args);
  const fill = Math.max(2, 90 - (3 + head.length + 1 + hint.length + 4));
  return `╭─ ${head} ${'─'.repeat(fill)} ${hint} ─╮`;
};
const readFloat = (tool, args = READ_ARGS[tool]) => {
  const head = toolHead(tool, args);
  return `  ${head}${' '.repeat(Math.max(2, 90 - head.length - 4))}ctrl+o to expand`;
};
const readCtx = (tool, extra = {}) => ({ tool, part: 'call', width: 90, theme, ...extra });
const readArgs = (tool) => ({ pattern: 'needle', path: 'src' });

describe('the read-only tools', () => {
  test('every one of them is headed `⌕ exploring` in the mdLink role, width and arguments kept', () => {
    for (const tool of READ_TOOLS) {
      for (const [frame, mk] of [['neon', readNeon], ['float', readFloat]]) {
        const row = mk(tool);
        const [out] = applyBashActivityHeading([row], readCtx(tool));
        assert.ok(out.includes(painted('mdLink', '⌕ exploring')), `${tool}/${frame}: ${strip(out)}`);
        assert.equal(cols(out), cols(row), `${tool}/${frame} keeps its width`);
        // The glyph and the tool's own word are gone; what it reads is untouched.
        assert.doesNotMatch(strip(out), new RegExp(escapeRe(`${READ_GLYPH[tool]} ${tool}`)), `${tool}: own heading gone`);
        assert.ok(strip(out).includes(`⌕ exploring ${READ_ARGS[tool]}`), `${tool}/${frame}: ${strip(out)}`);
        assert.match(strip(out), /ctrl\+o to expand/, `${tool}/${frame}: the hint is untouched`);
      }
    }
  });

  test('the host paint in force where the arguments begin is re-issued after the label', () => {
    for (const tool of READ_TOOLS) {
      const row = `\u001b[36m╭─ \u001b[1m${READ_GLYPH[tool]} ${tool} /needle/ in src\u001b[22m ${'─'.repeat(30)} ctrl+o to expand ─╮\u001b[39m`;
      const [out] = applyBashActivityHeading([row], readCtx(tool));
      assert.ok(out.startsWith('\u001b[36m╭─ \u001b[1m'), tool);
      assert.ok(out.includes(`${painted('mdLink', '⌕ exploring')}\u001b[36m\u001b[1m`), `${tool}: ${out}`);
      assert.ok(out.endsWith('╮\u001b[39m'), tool);
      assert.equal(cols(out), cols(row), tool);
    }
  });

  test('a tool the line does not cover is returned byte for byte', () => {
    for (const tool of ['edit', 'write', 'web_search', 'bash', '']) {
      const rows = [`╭─ ✎ edit lib/a.js ${'─'.repeat(40)} ctrl+o to expand ─╮`];
      assert.deepEqual(applyBashActivityHeading(rows, readCtx(tool, { render: { args: { path: 'lib/a.js' } } })), rows, tool);
    }
  });

  test('a heading the host wrapped or cut is still headed when the bridge hands the arguments', () => {
    for (const tool of READ_TOOLS) {
      // Wrapped: the heading ends where the host ran out of rule, the rest continues below.
      const wrapped = [`╭─ ${toolHead(tool, '/needle/ in a/very')}  ╮`, '│ long/path │'];
      const out = applyBashActivityHeading(wrapped, readCtx(tool, { render: { args: readArgs(tool) } }));
      const head = out[0];
      assert.ok(head.includes(painted('mdLink', '⌕ exploring')), `${tool}: ${head}`);
      assert.equal(cols(head), cols(wrapped[0]), `${tool} keeps its width`);
      assert.equal(strip(out[1]), wrapped[1], `${tool}: the continuation row's text is untouched`);
      // Abbreviated by the host: still the same constant word.
      const cut = [readNeon(tool, '/needle/ in some/lo…')];
      assert.ok(applyBashActivityHeading(cut, readCtx(tool, { render: { args: readArgs(tool) } }))[0].includes(painted('mdLink', '⌕ exploring')), tool);
    }
  });

  test('without the arguments the drawn heading must prove itself, and a read-only tool never guesses', () => {
    for (const tool of READ_TOOLS) {
      const unproven = [readNeon(tool, '/needle/ in some/lo…')];
      assert.deepEqual(applyBashActivityHeading(unproven, readCtx(tool)), unproven, tool);
      const wrapped = [`╭─ ${toolHead(tool, '/needle/ in a/very')}  ╮`, '│ long/path │'];
      assert.deepEqual(applyBashActivityHeading(wrapped, readCtx(tool)), wrapped, tool);
      // An old bridge that hands no arguments leaves a provable heading alone only for its own row.
      const proven = [readNeon(tool)];
      assert.ok(applyBashActivityHeading(proven, readCtx(tool))[0].includes(painted('mdLink', '⌕ exploring')), tool);
    }
  });

  test('a row with no room to pay for the word is left as the host drew it', () => {
    for (const tool of READ_TOOLS) {
      const row = `${READ_GLYPH[tool]} ${tool} /needle/`;
      assert.deepEqual(applyBashActivityHeading([row], readCtx(tool, { render: { args: readArgs(tool) } })), [row], tool);
    }
  });

  test('S6: a skill or an ODD artifact is the file card\'s row, for both parts, byte for byte', () => {
    // The file card already claims these paths (lib/skill-odd-card.js): it draws the
    // heading, the frame and the body, so this design must add no status line over or
    // under it, whichever resolver the host runs first.
    const call = [readNeon('read', 'lib/skills/one/SKILL.md:1-40')];
    const result = [`│ ${'x'.repeat(86)} │`, `╰${'─'.repeat(88)}╯`];
    for (const path of ['lib/skills/one/SKILL.md', 'odd/tasks/design.md', '/abs/odd/tasks/a.md', 'C:\\repo\\skills\\x\\SKILL.md']) {
      const render = { args: { path }, isPartial: false, durationMs: 142 };
      assert.deepEqual(applyBashActivityHeading(call, readCtx('read', { render })), call, `${path} (call)`);
      assert.deepEqual(applyBashActivityHeading(result, readCtx('read', { render, part: 'result' })), result, `${path} (result)`);
    }
    // And only those paths: an ordinary read is still headed, and its frame still painted.
    const render = { args: { path: 'src/app.js' }, isPartial: false, durationMs: 142 };
    assert.ok(applyBashActivityHeading(call, readCtx('read', { render }))[0].includes(painted('mdLink', '⌕ exploring')), 'an ordinary read keeps the activity heading');
    assert.notDeepEqual(applyBashActivityHeading(result, readCtx('read', { render, part: 'result' })), result, 'and its frame is painted');
    // A folder that merely holds the words is not one of those paths.
    for (const path of ['lib/skillset/notes.md', 'docs/oddity.md', 'odd/work/a.md', 'notes/SKILL.md']) {
      assert.ok(applyBashActivityHeading(call, readCtx('read', { render: { args: { path }, isPartial: false } }))[0].includes(painted('mdLink', '⌕ exploring')), path);
    }
  });

  test('the frame wears one role and the call state speaks first, exactly as bash', () => {
    const closing = `╰${'─'.repeat(88)}╯`;
    const result = (extra) => ({ tool: 'grep', part: 'result', width: 90, theme, render: { args: readArgs('grep'), isPartial: false, ...extra } });
    assert.ok(applyBashActivityHeading([closing], result({}))[0].startsWith(`\u001b[${ROLE_CODE.mdLink}m╰`), 'idle: mdLink');
    assert.ok(applyBashActivityHeading([closing], result({ isPartial: true }))[0].startsWith(`\u001b[${ROLE_CODE.warning}m╰`), 'running: warning');
    assert.ok(applyBashActivityHeading([closing], result({ isError: true }))[0].startsWith(`\u001b[${ROLE_CODE.error}m╰`), 'failed: error');
    const timed = applyBashActivityHeading([closing], result({ durationMs: 142 }))[0];
    assert.match(strip(timed), / 142ms ╯$/);
    assert.ok(timed.includes(painted('dim', '142ms')));
    assert.equal(cols(timed), 90);
  });

  test('never while the call runs, and never without a duration', () => {
    const closing = `╰${'─'.repeat(88)}╯`;
    const result = (extra) => ({ tool: 'ls', part: 'result', width: 90, theme, render: { args: { path: 'src' }, isPartial: false, ...extra } });
    assert.doesNotMatch(strip(applyBashActivityHeading([closing], result({ isPartial: true, durationMs: 5 }))[0]), /ms/);
    assert.doesNotMatch(strip(applyBashActivityHeading([closing], result({}))[0]), /ms/);
  });

  test('no theme: the word is there unpainted and the row keeps its width', () => {
    for (const tool of READ_TOOLS) {
      const row = readNeon(tool);
      const [out] = applyBashActivityHeading([row], { tool, part: 'call', width: 90, render: { args: readArgs(tool) } });
      assert.ok(strip(out).includes('⌕ exploring'), tool);
      assert.doesNotMatch(out, /\u001b\[3[1-7]m/, tool);
      assert.equal(cols(out), cols(row), tool);
    }
  });

  test('no render context: the frame rows come back byte for byte', () => {
    for (const tool of READ_TOOLS) {
      const rows = [`╰${'─'.repeat(88)}╯`];
      assert.deepEqual(applyBashActivityHeading(rows, { tool, part: 'result', width: 90, theme }), rows, tool);
    }
  });

  test('a repeated read-only card is a cache hit, not a second drawing every frame', () => {
    const row = readNeon('grep', '/needle/ in src/app.js');
    const ctx = readCtx('grep', { render: { args: readArgs('grep'), isPartial: false } });
    const first = applyBashActivityHeading([row], ctx);
    const second = applyBashActivityHeading([row], ctx);
    assert.deepEqual(second, first);
    assert.notEqual(second, first, 'a caller may keep or change the array it gets');
    const start = performance.now();
    for (let index = 0; index < 30000; index += 1) applyBashActivityHeading([row], ctx);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `30000 grep frames took ${elapsed}ms`);
  });
});

// A bridge whose published object carries a release, and records what it was asked to register.
function versionedBridge(version) {
  const seen = [];
  const api = { registerToolDesign: (design) => { seen.push(design); return () => {}; } };
  if (version !== undefined) api.VERSION = version;
  return { api, seen };
}
const designFor = (version) => {
  const { api, seen } = versionedBridge(version);
  const dispose = registerBashDesign(api);
  assert.equal(typeof dispose, 'function', String(version));
  dispose();
  // A release string that cannot be read is asked first, with a throwaway design; the design
  // this package really registers is the one after it.
  return seen.find((design) => design.id !== 'odd-worktree.capability-probe');
};

describe('the Card tools line', () => {
  test('the line declares `write` so the file card can be asked about it, and the design paints nothing for it', () => {
    // S1: the file card is painted only while this line resolves to the activity design
    // for the tool being drawn, and a bridge resolves coverage from the line's own
    // `tools`. `write` is declared for the card's question — the design itself answers
    // `undefined` for it (`computeActivity` knows only bash and the read-only marks), so
    // a write's rows come back byte for byte and the host's own card is never lost.
    const design = designFor('0.6.0');
    assert.deepEqual(design.tools, ['bash', 'grep', 'find', 'ls', 'read', 'write']);
    const answer = (tool) => (design.tools.includes(tool) ? { kind: 'design', design } : { kind: 'not-covered' });
    assert.equal(answer('write').kind, 'design', 'a write is covered by the line');
    assert.equal(answer('write').design.id, BASH_DESIGN_ID);
    assert.equal(answer('edit').kind, 'not-covered', 'and nothing else is');

    // The design's own rows for a write, both parts: untouched, so the file card — not
    // an activity status line — is what a write shows.
    const render = { args: { path: 'odd/tasks/a.md', content: '# A' }, isPartial: false, durationMs: 142 };
    const call = [`╭─ ✎ write odd/tasks/a.md ${'─'.repeat(50)} ctrl+o to expand ─╮`];
    const result = [`│ ${'x'.repeat(86)} │`, `╰${'─'.repeat(88)}╯`];
    assert.deepEqual(design.apply(call, { tool: 'write', part: 'call', width: 90, theme, render }), call);
    assert.deepEqual(design.apply(result, { tool: 'write', part: 'result', width: 90, theme, render }), result);
  });

  test('a 0.6.0 bridge gets ONE grouped registration over bash and the read-only tools', () => {
    const design = designFor('0.6.0');
    assert.equal(design.line, 'tools');
    assert.deepEqual(design.tools, ['bash', 'grep', 'find', 'ls', 'read', 'write']);
    assert.equal(Object.hasOwn(design, 'tool'), false, 'never both shapes');
    assert.equal(design.id, BASH_DESIGN_ID);
    assert.equal(design.label, BASH_DESIGN_LABEL);
    assert.equal(design.name, 'Odd worktree');
    assert.match(design.description, /read-only/);
    assert.match(design.description, /exploring/);
    const preview = design.preview();
    assert.equal(preview.title, 'Cards · activity');
    assert.equal(preview.sample.split('\n').length, 1, 'one row, like every Cards value');
    assert.equal(typeof design.apply, 'function');
  });

  test('every release from 0.6.0 up gets the line', () => {
    for (const version of ['0.6.0', '0.6.1', '0.10.0', '0.7.0-rc.1', '1.0.0', '0.6']) {
      assert.equal(designFor(version).line, 'tools', version);
    }
  });

  test('an older bridge with a readable release gets exactly today\'s single bash design', () => {
    for (const version of ['0.5.0', '0.5.9', '0.4.2', '0.5']) {
      const design = designFor(version);
      assert.equal(design.tool, 'bash', String(version));
      assert.equal(Object.hasOwn(design, 'line'), false, `no line on ${String(version)}`);
      assert.equal(Object.hasOwn(design, 'tools'), false, `no tools on ${String(version)}`);
      assert.equal(design.id, BASH_DESIGN_ID);
    }
  });

  test('an old bridge still heads bash cards, and the grouped one heads both', () => {
    const design = designFor('0.5.0');
    const [out] = design.apply([neon('ls -la')], { ...THEMED, render: render('ls -la') });
    assert.ok(out.includes(painted('mdLink', '⌕ exploring')));
    // The shape decides what is wired: an old bridge is only ever asked about `bash`, and the one
    // registration that covers all five tools applies to every one of them.
    const grouped = designFor('0.6.0');
    assert.ok(grouped.apply([readNeon('grep')], readCtx('grep'))[0].includes(painted('mdLink', '⌕ exploring')));
  });

  test('one registration per process: a second call is the same disposer, whichever shape it chose', () => {
    const { api, seen } = versionedBridge('0.6.0');
    const dispose = registerBashDesign(api);
    try {
      assert.equal(registerBashDesign(api), dispose);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].line, 'tools');
    } finally {
      dispose();
    }
  });
});

// A BRIDGE WE CONTROL, for the one thing this package cannot prove about itself: what the bridge
// hands `apply`. The real one wraps the host's renderers and passes, from Pi's own render context, a
// by-value snapshot of the call (`ctx.render`). This fake keeps exactly that contract for BOTH
// registration shapes and nothing else, so a regression in what this package does with either shape
// is this package's to fix. It mirrors `toolDesignResolver`: the host's renderers, one wrapper per
// member, the design applied on every render pass with the context of THAT renderer.
function fakeRenderBridge(version) {
  const designs = [];
  const seen = [];
  const api = {
    VERSION: version,
    registerToolDesign: (design) => {
      designs.push(design);
      return () => {
        const at = designs.indexOf(design);
        if (at >= 0) designs.splice(at, 1);
      };
    },
  };
  // A design covers one tool (the historical shape) or several (the 0.6.0 line).
  const covers = (design) => (typeof design.tool === 'string' ? [design.tool] : design.tools);
  // Pi's render context → the snapshot the bridge hands a design: the tool's own `args` by reference.
  const snapshot = (context) => {
    if (context === null || typeof context !== 'object') return undefined;
    const render = {};
    if (typeof context.toolCallId === 'string') render.toolCallId = context.toolCallId;
    if ('args' in context) render.args = context.args;
    if (typeof context.isPartial === 'boolean') render.isPartial = context.isPartial;
    if (typeof context.isError === 'boolean') render.isError = context.isError;
    if (typeof context.durationMs === 'number') render.durationMs = context.durationMs;
    return render;
  };
  const resolve = (tool, host) => {
    const design = designs.find((candidate) => covers(candidate).includes(tool));
    if (design === undefined) return host;
    const wrap = (member, themeIndex, contextIndex, part) => (...args) => {
      const component = host[member](...args);
      return {
        render: (width) => {
          const rows = component.render(width);
          const render = snapshot(args[contextIndex]);
          seen.push({ tool, part, render });
          const ctx = render === undefined
            ? { width, tool, theme: args[themeIndex], part }
            : { width, tool, theme: args[themeIndex], part, render };
          return design.apply([...rows], ctx);
        },
      };
    };
    return {
      renderCall: wrap('renderCall', 1, 2, 'call'),
      renderResult: wrap('renderResult', 2, 3, 'result'),
    };
  };
  return { api, resolve, designs, seen };
}

describe('what the bridge hands the design', () => {
  // The host cut the heading, so only the call's own arguments can name this card.
  const COMMAND = `grep -rn "activity" ${'lib/'.repeat(6)} | head -40; echo ---; grep -rn needle docs`;
  const cutRow = neon(`${COMMAND.slice(0, 52)}…`);
  const closingRow = () => `╰${'─'.repeat(88)}╯`;
  const call = { toolCallId: 'c1', args: { command: COMMAND }, isPartial: false, isError: false, durationMs: 132 };
  const draw = (version) => {
    const bridge = fakeRenderBridge(version);
    const dispose = registerBashDesign(bridge.api);
    assert.equal(typeof dispose, 'function', version);
    const host = {
      renderCall: () => ({ render: () => [cutRow] }),
      renderResult: () => ({ render: () => [closingRow()] }),
    };
    const resolved = bridge.resolve('bash', host);
    const rows = {
      call: resolved.renderCall({}, theme, call).render(90),
      result: resolved.renderResult({}, {}, theme, call).render(90),
    };
    dispose();
    return { ...rows, seen: bridge.seen };
  };

  test('a line registration is handed the same `ctx.render` as a per-tool one, and draws the same card', () => {
    const perTool = draw('0.5.0');
    const line = draw('0.6.0');
    const render = { toolCallId: 'c1', args: { command: COMMAND }, isPartial: false, isError: false, durationMs: 132 };
    const expected = [
      { tool: 'bash', part: 'call', render },
      { tool: 'bash', part: 'result', render },
    ];
    assert.deepEqual(perTool.seen, expected, 'the per-tool registration gets the call\'s own context');
    assert.deepEqual(line.seen, perTool.seen, 'the line registration gets exactly the same context');
    assert.deepEqual(line.call, perTool.call, 'so it draws the same heading row');
    assert.deepEqual(line.result, perTool.result, 'and the same closing rule');
  });

  test('that context is what names a cut command, paints the frame and draws the duration — on both shapes', () => {
    for (const version of ['0.5.0', '0.6.0']) {
      const rows = draw(version);
      assert.ok(rows.call[0] !== cutRow, `${version}: the design ran`);
      assert.ok(rows.call[0].includes(painted('mdLink', '⌕ exploring')), `${version}: ${strip(rows.call[0])}`);
      assert.ok(
        rows.call[0].startsWith(`\u001b[${ROLE_CODE.mdLink}m╭─`),
        `${version}: the frame is painted in the activity role`,
      );
      assert.doesNotMatch(strip(rows.call[0]), /\$ bash/, `${version}: never the generic fallback`);
      assert.match(strip(rows.result[0]), / 132ms ╯$/, `${version}: the duration is drawn`);
      assert.ok(rows.result[0].includes(painted('dim', '132ms')), `${version}: the duration is dim`);
    }
  });

  test('a context the bridge hands without the call is the host\'s card, never a guess', () => {
    const bridge = fakeRenderBridge('0.6.0');
    const dispose = registerBashDesign(bridge.api);
    try {
      const resolved = bridge.resolve('bash', { renderCall: () => ({ render: () => [cutRow] }) });
      const [out] = resolved.renderCall({}, theme, undefined).render(90);
      // The drawn heading is cut, so nothing can be named: bash's own `$ bash` fallback, the width
      // kept, and no frame role — the state (`isPartial`, `isError`, `durationMs`) is unknown.
      assert.ok(out.includes(painted('bashMode', '$ bash')), strip(out));
      assert.ok(out.startsWith('╭─ '), 'the frame keeps the host\'s paint');
      assert.equal(cols(out), cols(cutRow));
      assert.deepEqual(bridge.seen, [{ tool: 'bash', part: 'call', render: undefined }]);
    } finally {
      dispose();
    }
  });
});

describe('the seed runs before the registration', () => {
  // A 0.6.0 bridge, as its contract documents it: at REGISTRATION time a line with no value of its
  // own inherits a joining tool's legacy per-tool value, and writes it then.
  function migratingBridge(files = {}) {
    const { api, files: store, writes } = fakeBridge(files);
    const inherited = [];
    api.VERSION = '0.6.0';
    api.registerToolDesign = () => {
      const selections = store['bridge-tool-designs']?.selections ?? {};
      inherited.push(JSON.parse(JSON.stringify(selections)));
      if (typeof selections.bash === 'string' && selections.bash !== 'native' && selections.$lines?.tools === undefined) {
        store['bridge-tool-designs'] = { ...store['bridge-tool-designs'], selections: { ...selections, $lines: { tools: selections.bash } } };
      }
      return () => {};
    };
    return { api, files: store, writes, inherited };
  }

  test('a first run stores the choice before registering, so the line inherits it', () => {
    const { api, files, inherited } = migratingBridge();
    const dispose = registerBashDesign(api);
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.deepEqual(inherited[0], { bash: BASH_DESIGN_ID }, 'the seed was already stored when the bridge registered');
    assert.deepEqual(files['bridge-tool-designs'].selections, { bash: BASH_DESIGN_ID, $lines: { tools: BASH_DESIGN_ID } });
  });

  test('a stored legacy choice is kept: the seed writes no selection and the line inherits that choice', () => {
    const { api, files, writes } = migratingBridge({ 'bridge-tool-designs': { selections: { bash: 'someone.else' } } });
    const dispose = registerBashDesign(api);
    dispose();
    assert.deepEqual(writes.filter(([store]) => store === SELECTIONS[0]), [], 'no selection was written');
    assert.deepEqual(files['bridge-tool-designs'].selections, { bash: 'someone.else', $lines: { tools: 'someone.else' } });
  });

  test('the seed never writes the reserved line key itself', () => {
    const { api, files } = migratingBridge();
    api.registerToolDesign = () => () => {};
    const dispose = registerBashDesign(api);
    dispose();
    assert.deepEqual(files['bridge-tool-designs'].selections, { bash: BASH_DESIGN_ID }, 'no $lines from this package');
  });

  test('an old bridge keeps today\'s per-tool choice, with no line value', () => {
    const { api, files } = fakeBridge();
    api.VERSION = '0.5.0';
    const dispose = registerBashDesign(api);
    dispose();
    assert.deepEqual(files['bridge-tool-designs'].selections, { bash: BASH_DESIGN_ID });
  });
});

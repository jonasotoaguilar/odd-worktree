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

describe('the registration', () => {
  test('is one bash design with the label the bridge line shows and a preview', () => {
    const design = bashActivityDesign();
    assert.equal(design.tool, 'bash');
    assert.equal(design.id, BASH_DESIGN_ID);
    assert.equal(design.label, BASH_DESIGN_LABEL);
    assert.equal(BASH_DESIGN_LABEL, 'activity');
    const preview = design.preview();
    assert.equal(preview.title, 'Cards · activity');
    assert.ok(preview.sample.split('\n').length >= 3);
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

  test('registering the design on a bridge seeds it, and a rejected registration seeds nothing', () => {
    const accepted = fakeBridge();
    const dispose = registerBashDesign(accepted.api);
    assert.equal(typeof dispose, 'function');
    assert.equal(accepted.files['bridge-tool-designs'].selections.bash, BASH_DESIGN_ID);
    dispose();
    const refused = fakeBridge();
    refused.api.registerToolDesign = () => { throw new Error('refused'); };
    assert.equal(registerBashDesign(refused.api), null);
    assert.deepEqual(refused.writes, []);
  });
});

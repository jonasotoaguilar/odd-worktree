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

  test('an unnamed command keeps the host row byte for byte', () => {
    const rows = [neon('cd /tmp'), neon('frobnicate --now')];
    for (const row of rows) assert.deepEqual(applyBashActivityHeading([row], CALL), [row]);
  });

  test('a heading that does not prove the whole command is never named', () => {
    const unproven = [
      neon('sed -n 1,40p a.ts … +3 lines'),
      neon('ls -la some/very/long/pa…'),
      float('ls -la && rm -rf x…'),
    ];
    for (const row of unproven) assert.deepEqual(applyBashActivityHeading([row], CALL), [row], row);
    // A continuation row means the heading is only the first line of the command.
    const multi = [neon('ls'), '│ rm -rf build │'];
    assert.deepEqual(applyBashActivityHeading(multi, CALL), multi);
  });

  test('text after the command that is not the host fill or hint is never named', () => {
    const row = '  $ ls  &&  rm -rf build' + ' '.repeat(20);
    assert.deepEqual(applyBashActivityHeading([row], CALL), [row]);
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

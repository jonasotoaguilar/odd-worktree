'use strict';
// The `diff` design (T2, S1/S2/S5/S7/S8): what a caller of the bridge's `registerToolDesign`
// observes on the second `Card diff` line, and the rows it draws.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  DIFF_DESIGN_ID,
  DIFF_DESIGN_LABEL,
  DIFF_DESIGN_PREVIEW,
  applyDiffCard,
  applyDiffDesign,
  bridgeSupportsDiffLine,
  diffColorDesign,
  registerDiffDesign,
  seedDiffDesignSelection,
} = require('../lib/diff-design.js');

const WIDTH = 60;
// A theme that NAMES the role it was asked for, so a row states its paint instead of an escape.
const theme = { fg: (role, text) => `<${role}>${text}</${role}>` };
// The same theme, stripped back to the text a terminal would show: the role tags of the fake theme
// and the escape sequences the host's own highlighter emits.
const unpaint = (row) => row.replace(/<\/?[a-z][A-Za-z0-9]*>/gu, '').replace(/\u001b\[[0-9;]*m/gu, '');
const cols = (row) => Array.from(unpaint(row)).length;
// The paint Pi's highlighter hands back: an escape sequence around the line's own text.
const HIGHLIGHT = (line) => `\u001b[36m${line}\u001b[39m`;
// One frame cell painted in the tone's role, as the host paints it.
const toneCell = (cell) => `\u001b[32m${cell}\u001b[39m`;

// ---- the host's two card halves, as Gentle Shell's quiet tool card draws them -------------
//
// The host's card is `renderShell: "self"` and split across the two halves: the CALL rows are the
// frame's top rule (the heading, and — once the call finished — the host's own expand hint); the
// RESULT rows are one band row (float only), the body rows between the frame's sides, and the
// closing rule. Every row below is exactly WIDTH columns.

const NEON_PREFIX = `${toneCell('│')} `;
const NEON_TAIL = ` ${toneCell('│')}`;
const neonBody = (text) => `${NEON_PREFIX}${text.padEnd(WIDTH - 4)}${NEON_TAIL}`;
const neonClose = () => `╰${'─'.repeat(WIDTH - 2)}╯`;
const neonCall = (hint = 'ctrl+o to expand') => {
  const head = '╭─ + write lib/app.js (2 lines) ';
  const tail = ` ${hint} ─╮`;
  return `${head}${'─'.repeat(WIDTH - head.length - tail.length)}${tail}`;
};

const FLOAT_PREFIX = ' ▎ ';
const FLOAT_TAIL = '   ';
const floatBand = () => ` ▎${' '.repeat(WIDTH - 2)}`;
const floatBody = (text) => `${FLOAT_PREFIX}${text.padEnd(WIDTH - 6)}${FLOAT_TAIL}`;
const floatClose = floatBand;
const floatCall = (hint = 'ctrl+o to expand') => [floatBand(), floatBody(`+ write lib/app.js (2 lines)  ${hint}`)];

const editCard = () => [
  '╭─ edit lib/app.js ─────────────────────╮',
  '│ @@ -12,2 +12,2 @@                     │',
  '│ -12 const total = 1                   │',
  '│ +12 const total = 2                   │',
  '│  13 return total                      │',
  '╰───────────────────────────────────────╯',
];

// The seam `extensions/odd-worktree-tools.ts` hands over: Pi's own highlighter and language mapper.
const seamFor = (languages = { language: 'javascript' }) => {
  const asked = [];
  return {
    asked,
    seam: {
      highlight: (code, language) => {
        asked.push([code, language]);
        if (language === undefined) return undefined;
        return code.split('\n').map((line) => (line === '' ? '' : HIGHLIGHT(line)));
      },
      languageForPath: () => languages.language,
    },
  };
};

const callCtx = (extra = {}) => ({ tool: 'write', part: 'call', width: WIDTH, theme, ...extra });
const resultCtx = (extra = {}) => ({ tool: 'write', part: 'result', width: WIDTH, theme, ...extra });

// A two-line write, its two host halves, and the design that paints it.
const WRITE_ARGS = { path: 'lib/app.js', content: 'const x = 1\nconst y = 2' };
const writeHalves = () => ({ call: [neonCall()], result: [neonBody('✓ wrote 22 bytes'), neonClose()] });

describe('the Card diff line (S2)', () => {
  test('one grouped registration over write and edit, labelled `color`', () => {
    const design = diffColorDesign(seamFor().seam);
    assert.equal(design.line, 'diff');
    assert.deepEqual(design.tools, ['write', 'edit']);
    assert.equal(Object.hasOwn(design, 'tool'), false, 'never both shapes');
    assert.equal(design.id, DIFF_DESIGN_ID);
    assert.equal(design.id, 'odd-worktree.diff');
    assert.equal(design.label, DIFF_DESIGN_LABEL);
    assert.equal(design.label, 'color', 'the value the user reads on the Cards row');
    assert.equal(design.name, 'Odd worktree');
    assert.equal(typeof design.description, 'string');
    assert.doesNotMatch(design.description, /[\r\n]/u, 'a description is ONE line');
    assert.equal(typeof design.apply, 'function');
    assert.equal(typeof design.preview, 'function');
  });

  test('the preview is ONE row, titled after the value', () => {
    const preview = diffColorDesign(seamFor().seam).preview();
    assert.equal(preview.title, `Cards · ${DIFF_DESIGN_LABEL}`);
    assert.equal(preview.title, 'Cards · color');
    assert.equal(preview.sample.split('\n').length, 1, 'one row, like every Cards value');
    assert.deepEqual(preview, DIFF_DESIGN_PREVIEW);
  });

  test('it registers once, and a second call is the same disposer', () => {
    const seen = [];
    const api = { VERSION: '0.9.0', registerToolDesign: (design) => { seen.push(design); return () => seen.pop(); } };
    const dispose = registerDiffDesign(api, seamFor().seam);
    assert.equal(typeof dispose, 'function');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].line, 'diff');
    assert.equal(registerDiffDesign(api, seamFor().seam), dispose, 'a second call is the same registration');
    dispose();
    dispose();
    assert.equal(seen.length, 0);
  });
});

describe('S6: an old or absent bridge registers nothing and never throws', () => {
  test('no bridge member means no registration', () => {
    for (const api of [null, undefined, {}, { registerToolDesign: 'nope' }]) {
      assert.equal(registerDiffDesign(api, seamFor().seam), null, String(api));
    }
  });

  test('a release older than the per-(line, tool) claim registers nothing', () => {
    for (const version of ['0.5.0', '0.6.0', '0.8.9', '0.8', 'nightly', '', 'v0.9.0', undefined, 0.9]) {
      const seen = [];
      const api = { VERSION: version, registerToolDesign: (design) => { seen.push(design); return () => {}; } };
      assert.equal(registerDiffDesign(api, seamFor().seam), null, String(version));
      assert.deepEqual(seen, [], `${String(version)}: nothing was offered for a row the bridge would refuse`);
      assert.equal(bridgeSupportsDiffLine(api), false, String(version));
    }
  });

  test('every release from 0.9.0 up registers the line', () => {
    for (const version of ['0.9.0', '0.9.1', '0.10.0', '0.9', '1.0.0']) {
      const seen = [];
      const api = { VERSION: version, registerToolDesign: (design) => { seen.push(design); return () => {}; } };
      const dispose = registerDiffDesign(api, seamFor().seam);
      assert.equal(typeof dispose, 'function', version);
      dispose();
      assert.equal(seen.length, 1, version);
      assert.equal(seen[0].line, 'diff', version);
      assert.equal(bridgeSupportsDiffLine(api), true, version);
    }
  });

  test('a prerelease or a build suffix of the cutoff never meets it, so no diff line is offered', () => {
    // Semver puts a prerelease BELOW its own release, so `0.9.0-rc.1` does not carry the per-(`line`,
    // `tool`) claim 0.9.0 introduced; a build suffix is read the same conservative way, because a
    // refused registration is worse than a missing row.
    for (const version of ['0.9.0-rc.1', '0.9.0+build.7', '0.9.0-rc.1+sha.abc']) {
      const seen = [];
      const api = { VERSION: version, registerToolDesign: (design) => { seen.push(design); return () => {}; } };
      assert.equal(bridgeSupportsDiffLine(api), false, version);
      assert.equal(registerDiffDesign(api, seamFor().seam), null, version);
      assert.deepEqual(seen, [], `${version}: nothing is offered for a row the bridge would refuse`);
    }
  });

  test('a bridge that refuses the registration is null, never a throw', () => {
    const api = { VERSION: '0.9.0', registerToolDesign: () => { throw new Error('refused'); } };
    assert.doesNotThrow(() => registerDiffDesign(api, seamFor().seam));
    assert.equal(registerDiffDesign(api, seamFor().seam), null);
  });
});

describe('the first-run selection (S2)', () => {
  function fakeBridge(files = {}) {
    const writes = [];
    const createStore = (id) => ({
      get: (key, fallback) => (files[id] && Object.hasOwn(files[id], key) ? files[id][key] : fallback),
      set: (key, value) => { writes.push([id, key]); files[id] = { ...files[id], [key]: value }; },
    });
    return { api: { VERSION: '0.9.0', registerToolDesign: () => () => {}, createStore }, files, writes };
  }

  test('a first load with no choice selects color on the line and touches nothing else', () => {
    const { api, files } = fakeBridge({
      'bridge-tool-designs': { selections: { bash: 'odd-worktree.bash-activity', $lines: { tools: 'odd-worktree.bash-activity' } } },
    });
    assert.equal(seedDiffDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections, {
      bash: 'odd-worktree.bash-activity',
      $lines: { tools: 'odd-worktree.bash-activity', diff: DIFF_DESIGN_ID },
    });
  });

  test('a fresh install with no store file at all selects color', () => {
    const { api, files } = fakeBridge();
    assert.equal(seedDiffDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections, { $lines: { diff: DIFF_DESIGN_ID } });
  });

  test('a choice the user already made is never overwritten, default included', () => {
    for (const chosen of ['native', 'someone.else']) {
      const { api, files, writes } = fakeBridge({ 'bridge-tool-designs': { selections: { $lines: { diff: chosen } } } });
      assert.equal(seedDiffDesignSelection(api), false, chosen);
      assert.equal(files['bridge-tool-designs'].selections.$lines.diff, chosen, chosen);
      assert.equal(writes.some(([, key]) => key === 'selections'), false, 'nothing was written');
    }
  });

  test('it seeds once: default chosen afterwards stays default on the next load', () => {
    const { api, files } = fakeBridge();
    assert.equal(seedDiffDesignSelection(api), true);
    files['bridge-tool-designs'] = { selections: { $lines: { diff: 'native' } } };
    assert.equal(seedDiffDesignSelection(api), false);
    files['bridge-tool-designs'] = { selections: { $lines: {} } };
    assert.equal(seedDiffDesignSelection(api), false);
    assert.deepEqual(files['bridge-tool-designs'].selections, { $lines: {} });
  });

  test('a bridge without createStore, a malformed document or a failing store seeds nothing', () => {
    assert.equal(seedDiffDesignSelection({}), false);
    assert.equal(seedDiffDesignSelection(null), false);
    for (const selections of ['oops', [], null]) {
      const { api } = fakeBridge({ 'bridge-tool-designs': { selections } });
      assert.equal(seedDiffDesignSelection(api), false, JSON.stringify(selections));
    }
    const { api } = fakeBridge({ 'bridge-tool-designs': { selections: { $lines: 'oops' } } });
    assert.equal(seedDiffDesignSelection(api), false);
    const throwing = { createStore: () => { throw new Error('no store'); } };
    assert.doesNotThrow(() => seedDiffDesignSelection(throwing));
    assert.equal(seedDiffDesignSelection(throwing), false);
  });

  test('the seed follows an ACCEPTED registration only, so a refusal stores nothing', () => {
    const { api, files } = fakeBridge();
    api.registerToolDesign = () => { throw new Error('refused'); };
    assert.equal(registerDiffDesign(api, seamFor().seam), null);
    assert.equal(files['bridge-tool-designs'], undefined, 'no value names a design nobody registered');

    const accepted = fakeBridge();
    registerDiffDesign(accepted.api, seamFor().seam)();
    assert.equal(accepted.files['bridge-tool-designs'].selections.$lines.diff, DIFF_DESIGN_ID);
  });
});

describe('the write card keeps the host frame (S1)', () => {
  test('the call half is the host\'s own rows, so the frame top and the expand hint survive', () => {
    const design = diffColorDesign(seamFor().seam);
    const render = { args: WRITE_ARGS };
    const halves = writeHalves();
    assert.deepEqual(design.apply(halves.call, callCtx({ render })), halves.call);
    assert.match(design.apply(halves.call, callCtx({ render }))[0], /ctrl\+o to expand/u, 'the host\'s affordance');
    // The float style draws the same half as a band row plus a heading row; both are the host's.
    const floats = floatCall();
    assert.deepEqual(design.apply(floats, callCtx({ render })), floats);
    assert.match(unpaint(design.apply(floats, callCtx({ render }))[1]), /ctrl\+o to expand/u);
  });

  test('the pane is painted INSIDE the frame, on the result half', () => {
    const { seam } = seamFor();
    const halves = writeHalves();
    const rows = diffColorDesign(seam).apply(halves.result, resultCtx({ render: { args: WRITE_ARGS } }));
    assert.equal(rows.length, 3, 'two numbered rows between the frame\'s sides, then the host\'s closing rule');
    // Every pane row wears the host's own frame cells...
    for (const row of rows.slice(0, -1)) {
      assert.ok(row.startsWith(NEON_PREFIX), `"${row}" is not wearing the host's side`);
      assert.ok(row.endsWith(NEON_TAIL), `"${row}" is not wearing the host's rail`);
    }
    // ...and the body is the gutter plus the host's own highlighting.
    assert.ok(rows[0].includes(`<muted> 1</muted> <dim>│</dim> ${HIGHLIGHT('const x = 1')}`), rows[0]);
    assert.ok(rows[1].includes(`<muted> 2</muted> <dim>│</dim> ${HIGHLIGHT('const y = 2')}`), rows[1]);
    // The host's closing rule is untouched, its summary row is what the pane replaces.
    assert.equal(rows.at(-1), halves.result.at(-1));
    assert.equal(unpaint(rows.join('\n')).includes('wrote 22 bytes'), false);
    for (const row of rows) assert.equal(cols(row), WIDTH, `"${unpaint(row)}" is not ${WIDTH} columns`);
  });

  test('the host\'s own frame bytes are reused, tone paint and background reset included', () => {
    const painted = (text) => neonBody(text);
    const result = [painted('✓ wrote 22 bytes'), neonClose()];
    const rows = diffColorDesign(seamFor().seam).apply(result, resultCtx({ render: { args: WRITE_ARGS } }));
    for (const row of rows.slice(0, -1)) {
      assert.ok(row.startsWith(NEON_PREFIX), 'the side keeps the host\'s exact bytes');
      assert.ok(row.endsWith(NEON_TAIL), 'and so does the rail');
    }
    assert.equal(cols(rows[0]), WIDTH);
  });

  test('float: the leading band row and the closing bar are the host\'s, the body wears the band', () => {
    const result = [floatBand(), floatBody('✓ wrote 22 bytes'), floatClose()];
    const rows = diffColorDesign(seamFor().seam).apply(result, resultCtx({ render: { args: WRITE_ARGS } }));
    assert.deepEqual(rows[0], result[0], 'the host\'s band row is kept byte for byte');
    assert.equal(rows.at(-1), result.at(-1), 'and so is its closing bar');
    assert.equal(rows.length, 4, 'the band, two numbered rows and the closing bar');
    for (const row of rows) assert.equal(cols(row), WIDTH, `"${unpaint(row)}" is not ${WIDTH} columns`);
    for (const row of rows.slice(1, -1)) {
      assert.ok(row.startsWith(FLOAT_PREFIX), row);
      assert.ok(row.endsWith(FLOAT_TAIL), row);
    }
  });

  test('collapsed keeps the host budget and folds; expanded shows all of it, inside the frame', () => {
    const content = Array.from({ length: 14 }, (_value, index) => `line ${index + 1}`).join('\n');
    const design = diffColorDesign(seamFor().seam);
    const result = [neonBody('✓ wrote 22 bytes'), neonClose()];
    const collapsed = design.apply(result, resultCtx({ render: { args: { path: 'lib/app.js', content } } }));
    assert.equal(collapsed.length, 12, 'ten body rows, the fold row and the closing rule');
    assert.match(unpaint(collapsed.at(-2)), /… \+4 lines/u, 'the rest is stated, not silently dropped');
    assert.equal(unpaint(collapsed.at(-2)).includes('line 11'), false);
    assert.equal(collapsed.at(-1), result.at(-1));

    const expanded = design.apply(result, resultCtx({ render: { args: { path: 'lib/app.js', content }, expanded: true } }));
    assert.equal(expanded.length, 15, 'every line and the closing rule');
    assert.equal(unpaint(expanded[13]).includes('line 14'), true);
    assert.equal(expanded.at(-1), result.at(-1));
    for (const row of [...collapsed, ...expanded]) assert.equal(cols(row), WIDTH);
  });

  test('a clipped line is measured as PLAIN text, so no painted row is ever cut', () => {
    const long = `${'const value = '.repeat(12)}1;`;
    const { seam, asked } = seamFor();
    const result = ['▎ unused'.padEnd(WIDTH - 1), neonClose()];
    const rows = diffColorDesign(seam).apply([neonBody('✓ wrote 22 bytes'), neonClose()], resultCtx({ render: { args: { path: 'lib/app.js', content: long } } }));
    const body = rows[0];
    assert.equal(cols(body), WIDTH);
    assert.ok(unpaint(body).includes('…'), 'the row ends in the ellipsis the clip wrote');
    assert.equal(body.includes('\u001b[36m'), false, 'a clipped line is drawn plain, never cut out of a paint');
    assert.ok(asked.length > 0, 'the highlighter was asked for the whole body');
    assert.equal(result.length, 2);
  });

  test('tabs are expanded and trailing blank lines dropped, as the host card does', () => {
    const rows = diffColorDesign(seamFor().seam).apply(
      [neonBody('✓ written'), neonClose()],
      resultCtx({ render: { args: { path: 'a.js', content: 'a\tb\n\n\n' } } }),
    );
    assert.equal(rows.length, 2, 'one numbered row and the closing rule');
    assert.equal(unpaint(rows[0]).includes('a   b'), true, 'a tab is three columns');
  });

  test('an error is the card: the host\'s result rows come back byte for byte', () => {
    const lines = [neonBody('ENOENT: no such file'), neonClose()];
    const rows = diffColorDesign(seamFor().seam).apply(lines, resultCtx({ render: { args: WRITE_ARGS, isError: true } }));
    assert.deepEqual(rows, lines);
  });

  test('rows with no frame and nothing to draw are the host\'s own', () => {
    const design = diffColorDesign(seamFor().seam);
    assert.deepEqual(design.apply([], resultCtx({ render: { args: WRITE_ARGS } })), []);
    assert.deepEqual(design.apply(undefined, resultCtx({ render: { args: WRITE_ARGS } })), []);
    assert.deepEqual(design.apply(['plain result'], resultCtx({ render: { args: WRITE_ARGS } })), ['plain result']);
    assert.deepEqual(design.apply(['only the closing rule'], resultCtx({ render: { args: WRITE_ARGS } })), ['only the closing rule']);
  });

  test('painted twice is the same rows: the design never stacks its own drawing', () => {
    const ctx = resultCtx({ render: { args: WRITE_ARGS } });
    const design = diffColorDesign(seamFor().seam);
    const once = design.apply(writeHalves().result, ctx);
    assert.deepEqual(design.apply(once, ctx), once);
    const call = writeHalves().call;
    assert.deepEqual(design.apply(design.apply(call, callCtx({ render: { args: WRITE_ARGS } })), callCtx({ render: { args: WRITE_ARGS } })), call);
  });
});

describe('a repaint reads the theme and the content of THIS pass (S1/S5)', () => {
  test('a theme switched under the same object repaints the syntax escapes', () => {
    // The host's highlighter resolves the ACTIVE theme on every call, so the escapes it hands back
    // are theme-dependent: a drawing cached on the text alone answers a switched theme with the
    // colours of the old one, which is exactly what this card exists to avoid.
    const live = { palette: 36, fg(role, text) { return `\u001b[${this.palette}m${text}\u001b[39m`; } };
    const seam = {
      highlight: (code) => code.split('\n').map((line) => (line === '' ? '' : live.fg('syntaxKeyword', line))),
      languageForPath: () => 'javascript',
    };
    const design = diffColorDesign(seam);
    const ctx = { tool: 'write', part: 'result', width: WIDTH, theme: live, render: { args: WRITE_ARGS } };
    const before = design.apply(writeHalves().result, ctx);
    assert.ok(before.some((row) => row.includes('\u001b[36m')), 'the first pass is the first theme');
    live.palette = 34;
    const after = design.apply(writeHalves().result, ctx);
    assert.equal(after.some((row) => row.includes('\u001b[36m')), false, 'no escape of the old theme survives');
    assert.ok(after.some((row) => row.includes('\u001b[34m')), 'the syntax escapes are the new theme\'s');
  });

  test('two writes of the same length never share a pane: the content is what draws', () => {
    const design = diffColorDesign(seamFor().seam);
    // Pi rewrites `content` on the SAME args object while the call streams, so a key built from its
    // length answers a brand-new body with the pane of the old one.
    const args = { path: 'lib/app.js', content: 'const x = 1' };
    const ctx = { tool: 'write', part: 'result', width: WIDTH, theme, render: { args } };
    const first = design.apply(writeHalves().result, ctx);
    args.content = 'const y = 2';
    const second = design.apply(writeHalves().result, ctx);
    assert.ok(first[0].includes(HIGHLIGHT('const x = 1')), first[0]);
    assert.ok(second[0].includes(HIGHLIGHT('const y = 2')), second[0]);
    assert.notDeepEqual(second, first);
  });
});

describe('a host that draws no frame gets the whole pane (S1)', () => {
  // Pi's own shell wraps the renderer's component, so a design sees the write BODY alone: heading,
  // content rows and the host's own fold row, which carries the expand affordance. This host never
  // reaches a design through gentle-shell-bridge today; the path exists so such a host degrades
  // into a drawn pane instead of an untouched card.
  const plainCall = (hint = '... (12 more lines, 22 total, ctrl+o to expand)') => [
    '+ write lib/app.js (2 lines)',
    '',
    'const x = 1',
    'const y = 2',
    hint,
  ];

  test('the pane is drawn on the call half, with the host\'s own hint row kept after the fold row', () => {
    const content = Array.from({ length: 14 }, (_value, index) => `line ${index + 1}`).join('\n');
    const hint = '... (4 more lines, 14 total, ctrl+o to expand)';
    const call = plainCall(hint);
    const rows = diffColorDesign(seamFor().seam).apply(call, callCtx({ render: { args: { path: 'lib/app.js', content } } }));
    assert.ok(rows.length > call.length, 'the pane was drawn');
    assert.match(rows[0], /^<toolTitle>✎ write<\/toolTitle> <accent>lib\/app\.js<\/accent>/u);
    assert.match(unpaint(rows.at(-2)), /… \+4 lines/u, 'our fold row');
    assert.equal(rows.at(-1), hint, 'then the host\'s own hint row, exactly as it drew it');
    for (const row of rows.slice(0, -1)) assert.equal(cols(row), WIDTH);
  });

  test('no hint is invented when the host drew none', () => {
    const rows = diffColorDesign(seamFor().seam).apply(
      plainCall(null).slice(0, 4),
      callCtx({ render: { args: WRITE_ARGS } }),
    );
    assert.equal(rows.some((row) => /to expand|to collapse/u.test(unpaint(row))), false);
    assert.equal(rows.length, 3, 'the heading and the two numbered lines');
  });

  test('the result half of an unframed host is never painted, so nothing is drawn twice', () => {
    const rows = diffColorDesign(seamFor().seam).apply([], resultCtx({ render: { args: WRITE_ARGS } }));
    assert.deepEqual(rows, []);
  });

  test('a path that is neither a skill nor an ODD still gets the pane', () => {
    const rows = diffColorDesign(seamFor().seam).apply(plainCall(), callCtx({ render: { args: { path: 'lib/oddity.js', content: 'x' } } }));
    assert.match(rows[0], /<accent>lib\/oddity\.js<\/accent>/u);
  });
});

describe('the edit diff, recoloured (S1)', () => {
  test('additions, deletions, hunk headers and context wear their roles, text untouched', () => {
    const { seam } = seamFor();
    const rows = diffColorDesign(seam).apply(editCard(), {
      tool: 'edit',
      part: 'call',
      width: WIDTH,
      theme,
      render: { args: { path: 'lib/app.js' } },
    });
    assert.equal(rows.length, 6, 'every row of the host card is still there');
    assert.equal(unpaint(rows[1]).includes('@@ -12,2 +12,2 @@'), true);
    assert.match(rows[1], /<muted>@@ -12,2 \+12,2 @@<\/muted>/u, 'a hunk header is muted');
    assert.match(rows[2], /<toolDiffRemoved>-12 <\/toolDiffRemoved>/u, 'a deletion is toolDiffRemoved');
    assert.match(rows[3], /<toolDiffAdded>\+12 <\/toolDiffAdded>/u, 'an addition is toolDiffAdded');
    // The code of a row is the host's highlighter, with the language the path names.
    assert.ok(rows[2].includes(HIGHLIGHT('const total = 1')), rows[2]);
    assert.ok(rows[3].includes(HIGHLIGHT('const total = 2')), rows[3]);
    // Context is the theme's plain text.
    assert.match(rows[4], /<muted>13 <\/muted>/u);
    assert.ok(rows[4].includes(HIGHLIGHT('return total')), rows[4]);
    // The frame and the row widths are the host's, byte for byte.
    assert.equal(rows[0], editCard()[0]);
    assert.equal(rows.at(-1), editCard().at(-1));
    for (const [index, row] of rows.entries()) assert.equal(cols(row), cols(editCard()[index]), `row ${index} keeps its width`);
  });

  test('the language comes from the call\'s own path, and nothing but the row\'s text is repainted', () => {
    const heard = [];
    const seam = {
      highlight: (code) => code.split('\n').map((line) => HIGHLIGHT(line)),
      languageForPath: (path) => { heard.push(path); return 'javascript'; },
    };
    // Its own rows, so the module's per-frame memo cannot answer this call from an earlier test.
    const rows = [...editCard(), '   (its own frame)'];
    const out = diffColorDesign(seam).apply(rows, { tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'lib/app.js' } } });
    assert.deepEqual(heard, ['lib/app.js']);
    assert.equal(out.length, rows.length);
    assert.ok(out[2].includes(HIGHLIGHT('const total = 1')));
  });

  test('a row already wearing this paint comes back identical: never painted twice', () => {
    const ctx = { tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'lib/app.js' } } };
    const design = diffColorDesign(seamFor().seam);
    const once = design.apply(editCard(), ctx);
    assert.deepEqual(design.apply(once, ctx), once);
    assert.deepEqual(design.apply(editCard(), { ...ctx, part: 'result' }).map(unpaint), once.map(unpaint));
  });

  test('a heading, a blank row and a fold notice are never mistaken for a diff row', () => {
    const rows = [
      '╭─ edit lib/app.js ─────────────────────╮',
      '',
      '  ... (12 more lines, 22 total, ctrl+o to expand)',
      '▎ edit lib/app.js',
    ];
    const out = diffColorDesign(seamFor().seam).apply(rows, {
      tool: 'edit',
      part: 'call',
      width: WIDTH,
      theme,
      render: { args: { path: 'lib/app.js' } },
    });
    assert.deepEqual(out, rows);
  });
});

describe('a skill or an ODD artifact is the file card\'s call (S8)', () => {
  for (const path of ['odd/tasks/card-diff.md', '/repo/skills/gentle-ai/SKILL.md', 'skills\\gentle-ai\\SKILL.md']) {
    test(`${path} comes back byte-identical, both halves, both tools`, () => {
      const design = diffColorDesign(seamFor().seam);
      const content = 'const x = 1';
      const halves = writeHalves();
      for (const tool of ['write', 'edit']) {
        for (const part of ['call', 'result']) {
          const rows = tool === 'edit' ? editCard() : halves[part];
          const ctx = { tool, part, width: WIDTH, theme, render: { args: { path, content } } };
          assert.deepEqual(design.apply(rows, ctx), rows, `${tool}/${part}`);
        }
      }
    });
  }
});

describe('a missing or broken highlighter degrades to plain rows', () => {
  const content = 'const x = 1\nconst y = 2';
  const result = () => [neonBody('✓ wrote 22 bytes'), neonClose()];

  test('no seam at all: the pane is still drawn inside the frame, in the theme\'s text role', () => {
    const rows = diffColorDesign(undefined).apply(result(), resultCtx({ render: { args: { path: 'lib/app.js', content } } }));
    assert.equal(rows.length, 3);
    assert.ok(rows[0].includes('<muted> 1</muted> <dim>│</dim> <text>const x = 1</text>'), rows[0]);
    assert.ok(unpaint(rows[0]).startsWith(`${unpaint(NEON_PREFIX)} 1 │ const x = 1`), unpaint(rows[0]));
    assert.ok(unpaint(rows[0]).endsWith(unpaint(NEON_TAIL)), unpaint(rows[0]));
    for (const row of rows) assert.equal(cols(row), WIDTH);
  });

  test('a highlighter that throws is no highlighter', () => {
    const seam = { highlight: () => { throw new Error('no grammar'); }, languageForPath: () => 'javascript' };
    let rows;
    assert.doesNotThrow(() => { rows = diffColorDesign(seam).apply(result(), resultCtx({ render: { args: { path: 'lib/app.js', content } } })); });
    assert.ok(rows[0].includes('<text>const x = 1</text>'), rows[0]);
    const edit = diffColorDesign(seam).apply(editCard(), { tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'a.js' } } });
    assert.match(edit[2], /<toolDiffRemoved>const total = 1<\/toolDiffRemoved>/u, 'the diff role carries the code');
  });

  test('a highlighter whose paint changes the text is not a paint', () => {
    const seam = { highlight: () => ['<syntaxKeyword>something else</syntaxKeyword>'], languageForPath: () => 'javascript' };
    const rows = diffColorDesign(seam).apply(result(), resultCtx({ render: { args: { path: 'lib/app.js', content: 'const x = 1' } } }));
    assert.ok(rows[0].includes('<text>const x = 1</text>'), rows[0]);
  });

  test('a highlighter that answers the wrong number of lines is not a paint either', () => {
    const seam = { highlight: () => ['<syntaxKeyword>x</syntaxKeyword>'], languageForPath: () => 'javascript' };
    const rows = diffColorDesign(seam).apply(result(), resultCtx({ render: { args: { path: 'lib/app.js', content } } }));
    assert.ok(rows[0].includes('<text>const x = 1</text>'), rows[0]);
  });
});

describe('the shape of the contract (S5)', () => {
  test('apply always hands back a fresh array of strings', () => {
    const design = diffColorDesign(seamFor().seam);
    const frozen = Object.freeze(['host row']);
    const ctx = callCtx({ render: { args: { path: 'lib/app.js', content: 'x' } } });
    assert.doesNotThrow(() => design.apply(frozen, ctx));
    const rows = design.apply(frozen, ctx);
    assert.ok(Array.isArray(rows));
    assert.notEqual(rows, frozen, 'never the caller\'s array');
    assert.ok(rows.every((row) => typeof row === 'string'));
    assert.deepEqual(design.apply(undefined, ctx), []);
    assert.deepEqual(design.apply(frozen, undefined), frozen);
    assert.deepEqual(applyDiffDesign(frozen, null, undefined), frozen);
    assert.deepEqual(design.apply([null], { ...ctx, tool: 'read' }).length, 1);
  });

  test('it never mutates the host\'s rows or the call\'s arguments', () => {
    const args = Object.freeze({ path: 'lib/app.js', content: 'const x = 1' });
    const rows = Object.freeze(['╭─ write lib/app.js ─╮']);
    assert.doesNotThrow(() => diffColorDesign(seamFor().seam).apply(rows, callCtx({ render: { args } })));
  });
});

'use strict';
// The `file` design (T2, S1/S2/S5/S7/S8): what a caller of the shell API's `registerToolDesign`
// observes on the second `Card file` line, and the rows it draws.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  FILE_DESIGN_ID,
  DIFF_DESIGN_LABEL,
  DIFF_DESIGN_PREVIEW,
  applyDiffDesign,
  shellApiSupportsDiffLine,
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

describe('the Card file line (S2/S5)', () => {
  test('one grouped registration over write and edit, labelled `color`', () => {
    const design = diffColorDesign(seamFor().seam);
    assert.equal(design.line, 'file');
    assert.deepEqual(design.tools, ['write', 'edit']);
    assert.equal(Object.hasOwn(design, 'tool'), false, 'never both shapes');
    assert.equal(design.id, FILE_DESIGN_ID);
    assert.equal(design.id, 'odd-worktree.file');
    assert.equal(design.label, DIFF_DESIGN_LABEL);
    assert.equal(design.label, 'color', 'the value the user reads on the Cards row');
    assert.equal(design.name, 'Odd worktree');
    assert.equal(typeof design.description, 'string');
    assert.doesNotMatch(design.description, /[\r\n]/u, 'a description is ONE line');
    assert.equal(typeof design.apply, 'function');
    assert.equal(typeof design.preview, 'function');
  });

  test('the row the shell API builds is `Card file`, and the preview is titled after it', () => {
    const design = diffColorDesign(seamFor().seam);
    // The shell API derives the row from the line key itself (`Card <line>`); this pins the name
    // the user reads on the menu, next to the `default` value.
    assert.equal(`Card ${design.line}`, 'Card file');
    const preview = design.preview();
    assert.equal(preview.title, 'Cards · Card file', 'the same title the `default` value shows');
    assert.equal(preview.sample.split('\n').length, 1, 'one row, like every Cards value');
    assert.deepEqual(preview, DIFF_DESIGN_PREVIEW);
  });

  test('it registers once, and a second call is the same disposer', () => {
    const seen = [];
    const api = { VERSION: '0.9.0', registerToolDesign: (design) => { seen.push(design); return () => seen.pop(); } };
    const dispose = registerDiffDesign(api, seamFor().seam);
    assert.equal(typeof dispose, 'function');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].line, 'file');
    assert.equal(registerDiffDesign(api, seamFor().seam), dispose, 'a second call is the same registration');
    dispose();
    dispose();
    assert.equal(seen.length, 0);
  });
});

describe('S6: an old or absent shell API registers nothing and never throws', () => {
  test('no shell API member means no registration', () => {
    for (const api of [null, undefined, {}, { registerToolDesign: 'nope' }]) {
      assert.equal(registerDiffDesign(api, seamFor().seam), null, String(api));
    }
  });

  test('a release older than the per-(line, tool) claim registers nothing', () => {
    for (const version of ['0.5.0', '0.6.0', '0.8.9', '0.8', 'nightly', '', 'v0.9.0', undefined, 0.9]) {
      const seen = [];
      const api = { VERSION: version, registerToolDesign: (design) => { seen.push(design); return () => {}; } };
      assert.equal(registerDiffDesign(api, seamFor().seam), null, String(version));
      assert.deepEqual(seen, [], `${String(version)}: nothing was offered for a row the shell API would refuse`);
      assert.equal(shellApiSupportsDiffLine(api), false, String(version));
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
      assert.equal(seen[0].line, 'file', version);
      assert.equal(shellApiSupportsDiffLine(api), true, version);
    }
  });

  test('a prerelease or a build suffix of the cutoff never meets it, so no diff line is offered', () => {
    // Semver puts a prerelease BELOW its own release, so `0.9.0-rc.1` does not carry the per-(`line`,
    // `tool`) claim 0.9.0 introduced; a build suffix is read the same conservative way, because a
    // refused registration is worse than a missing row.
    for (const version of ['0.9.0-rc.1', '0.9.0+build.7', '0.9.0-rc.1+sha.abc']) {
      const seen = [];
      const api = { VERSION: version, registerToolDesign: (design) => { seen.push(design); return () => {}; } };
      assert.equal(shellApiSupportsDiffLine(api), false, version);
      assert.equal(registerDiffDesign(api, seamFor().seam), null, version);
      assert.deepEqual(seen, [], `${version}: nothing is offered for a row the shell API would refuse`);
    }
  });

  test('a shell API that refuses the registration is null, never a throw', () => {
    const api = { VERSION: '0.9.0', registerToolDesign: () => { throw new Error('refused'); } };
    assert.doesNotThrow(() => registerDiffDesign(api, seamFor().seam));
    assert.equal(registerDiffDesign(api, seamFor().seam), null);
  });
});

describe('the first-run selection and the `diff` -> `file` carry-over (S2/S5)', () => {
  function fakeShellApi(files = {}) {
    const writes = [];
    const createStore = (id) => ({
      get: (key, fallback) => (files[id] && Object.hasOwn(files[id], key) ? files[id][key] : fallback),
      set: (key, value) => { writes.push([id, key]); files[id] = { ...files[id], [key]: value }; },
    });
    return { api: { VERSION: '0.9.0', registerToolDesign: () => () => {}, createStore }, files, writes };
  }

  test('a first load with no choice selects color on the line and touches nothing else', () => {
    const { api, files } = fakeShellApi({
      'bridge-tool-designs': { selections: { bash: 'odd-worktree.bash-activity', $lines: { tools: 'odd-worktree.bash-activity' } } },
    });
    assert.equal(seedDiffDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections, {
      bash: 'odd-worktree.bash-activity',
      $lines: { tools: 'odd-worktree.bash-activity', file: FILE_DESIGN_ID },
    });
  });

  test('a fresh install with no store file at all selects color', () => {
    const { api, files } = fakeShellApi();
    assert.equal(seedDiffDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections, { $lines: { file: FILE_DESIGN_ID } });
  });

  test('a saved `diff` design id is carried over mapped, and the old key is left in place', () => {
    const { api, files } = fakeShellApi({
      'bridge-tool-designs': { selections: { $lines: { diff: 'odd-worktree.diff' } } },
    });
    assert.equal(seedDiffDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections.$lines, {
      diff: 'odd-worktree.diff',
      file: FILE_DESIGN_ID,
    }, 'the new id under the new key, the old key untouched');
  });

  test('a saved reserved value is carried over as it is, so `default` stays `default`', () => {
    const { api, files } = fakeShellApi({
      'bridge-tool-designs': { selections: { $lines: { diff: 'native' } } },
    });
    assert.equal(seedDiffDesignSelection(api), true);
    assert.deepEqual(files['bridge-tool-designs'].selections.$lines, { diff: 'native', file: 'native' });
  });

  test('a choice the user already made on `file` is never overwritten, default included', () => {
    for (const chosen of ['native', 'someone.else']) {
      const { api, files, writes } = fakeShellApi({ 'bridge-tool-designs': { selections: { $lines: { file: chosen } } } });
      assert.equal(seedDiffDesignSelection(api), false, chosen);
      assert.equal(files['bridge-tool-designs'].selections.$lines.file, chosen, chosen);
      assert.equal(writes.some(([, key]) => key === 'selections'), false, 'nothing was written');
    }
  });

  test('a stored `file` value wins over a `diff` one beside it', () => {
    const { api, files } = fakeShellApi({
      'bridge-tool-designs': { selections: { $lines: { diff: 'odd-worktree.diff', file: 'native' } } },
    });
    assert.equal(seedDiffDesignSelection(api), false);
    assert.deepEqual(files['bridge-tool-designs'].selections.$lines, { diff: 'odd-worktree.diff', file: 'native' });
  });

  test('the marker set means no write at all, the carry-over included', () => {
    const { api, files, writes } = fakeShellApi({
      'odd-worktree': { fileDesignSeeded: true },
      'bridge-tool-designs': { selections: { $lines: { diff: 'odd-worktree.diff' } } },
    });
    assert.equal(seedDiffDesignSelection(api), false);
    assert.deepEqual(writes, [], 'neither store was written');
    assert.deepEqual(files['bridge-tool-designs'].selections.$lines, { diff: 'odd-worktree.diff' });
  });

  test('an old `diffDesignSeeded` marker alone does not block the carry-over', () => {
    const { api, files } = fakeShellApi({
      'odd-worktree': { diffDesignSeeded: true },
      'bridge-tool-designs': { selections: { $lines: { diff: 'odd-worktree.diff' } } },
    });
    assert.equal(seedDiffDesignSelection(api), true);
    assert.equal(files['bridge-tool-designs'].selections.$lines.file, FILE_DESIGN_ID);
    assert.equal(files['odd-worktree'].fileDesignSeeded, true);
  });

  test('it seeds once: default chosen afterwards stays default on the next load', () => {
    const { api, files, writes } = fakeShellApi();
    assert.equal(seedDiffDesignSelection(api), true);
    assert.equal(seedDiffDesignSelection(api), false);
    assert.deepEqual(writes.map(([id, key]) => `${id}/${key}`), [
      'bridge-tool-designs/selections',
      'odd-worktree/fileDesignSeeded',
    ], 'the selection once, then the marker');
    files['bridge-tool-designs'] = { selections: { $lines: { file: 'native' } } };
    assert.equal(seedDiffDesignSelection(api), false);
    files['bridge-tool-designs'] = { selections: { $lines: {} } };
    assert.equal(seedDiffDesignSelection(api), false);
    assert.deepEqual(files['bridge-tool-designs'].selections, { $lines: {} });
  });

  test('a shell API without createStore, a malformed document or a failing store seeds nothing', () => {
    assert.equal(seedDiffDesignSelection({}), false);
    assert.equal(seedDiffDesignSelection(null), false);
    for (const selections of ['oops', [], null]) {
      const { api } = fakeShellApi({ 'bridge-tool-designs': { selections } });
      assert.equal(seedDiffDesignSelection(api), false, JSON.stringify(selections));
    }
    const { api } = fakeShellApi({ 'bridge-tool-designs': { selections: { $lines: 'oops' } } });
    assert.equal(seedDiffDesignSelection(api), false);
    const throwing = { createStore: () => { throw new Error('no store'); } };
    assert.doesNotThrow(() => seedDiffDesignSelection(throwing));
    assert.equal(seedDiffDesignSelection(throwing), false);
  });

  test('a store that throws on a read or on a write changes nothing and never throws', () => {
    for (const failOn of ['get', 'set']) {
      const files = { 'bridge-tool-designs': { selections: { $lines: { diff: 'odd-worktree.diff' } } } };
      const before = JSON.stringify(files);
      const createStore = (id) => ({
        get: (key, fallback) => {
          if (failOn === 'get') throw new Error('no read');
          return files[id] && Object.hasOwn(files[id], key) ? files[id][key] : fallback;
        },
        set: (key, value) => {
          if (failOn === 'set') throw new Error('no write');
          files[id] = { ...files[id], [key]: value };
        },
      });
      const api = { VERSION: '0.9.0', registerToolDesign: () => () => {}, createStore };
      assert.doesNotThrow(() => seedDiffDesignSelection(api), failOn);
      assert.equal(seedDiffDesignSelection(api), false, failOn);
      assert.equal(JSON.stringify(files), before, `${failOn}: the document is byte-identical`);
    }
  });

  test('the seed follows an ACCEPTED registration only, so a refusal stores nothing', () => {
    const { api, files } = fakeShellApi();
    api.registerToolDesign = () => { throw new Error('refused'); };
    assert.equal(registerDiffDesign(api, seamFor().seam), null);
    assert.equal(files['bridge-tool-designs'], undefined, 'no value names a design nobody registered');

    const accepted = fakeShellApi();
    registerDiffDesign(accepted.api, seamFor().seam)();
    assert.equal(accepted.files['bridge-tool-designs'].selections.$lines.file, FILE_DESIGN_ID);
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
    const live = { palette: 36, fg(_role, text) { return `\u001b[${this.palette}m${text}\u001b[39m`; } };
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
  // reaches a design through the shell API today; the path exists so such a host degrades
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
  test('a deletion and an addition wear their whole role, a hunk header and context their own', () => {
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
    // S13: the whole row — marker, number, divider and code — is the ONE role, as `git diff` paints it.
    assert.match(rows[2], /<toolDiffRemoved>-12 │ const total = 1<\/toolDiffRemoved>/u, 'a deletion is toolDiffRemoved whole');
    assert.match(rows[3], /<toolDiffAdded>\+12 │ const total = 2<\/toolDiffAdded>/u, 'an addition is toolDiffAdded whole');
    // A changed row carries no syntax colour of its own: the role's colour is the whole point.
    assert.equal(rows[2].includes(HIGHLIGHT('const total = 1')), false, rows[2]);
    assert.equal(rows[3].includes(HIGHLIGHT('const total = 2')), false, rows[3]);
    // Context keeps today's drawing: the gutter, the divider and the host's own highlighting.
    assert.match(rows[4], /<muted>13<\/muted> <dim>│<\/dim> /u);
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
    const rows = [...editCard(), '   (its own frame)'];
    const out = diffColorDesign(seam).apply(rows, { tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'lib/app.js' } } });
    assert.deepEqual(heard, ['lib/app.js']);
    assert.equal(out.length, rows.length);
    // The highlighter is what a CONTEXT row's code is drawn with; a changed row is its role alone.
    assert.ok(out[4].includes(HIGHLIGHT('return total')), out[4]);
    assert.equal(out[2].includes(HIGHLIGHT('const total = 1')), false, out[2]);
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

describe('the edit row carries the write pane\'s gutter divider (S12)', () => {
  const ctx = () => ({ tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'lib/app.js' } } });

  test('the divider is the write pane\'s own, in the theme role that pane paints it', () => {
    const write = diffColorDesign(seamFor().seam).apply(writeHalves().result, resultCtx({ render: { args: WRITE_ARGS } }));
    assert.ok(write[0].includes('<muted> 1</muted> <dim>│</dim> '), `the write pane divides its gutter with the dim role: ${write[0]}`);
    const rows = diffColorDesign(seamFor().seam).apply(editCard(), ctx());
    assert.ok(rows[4].includes('<muted>13</muted> <dim>│</dim> '), `the edit draws the same one: ${rows[4]}`);
    assert.match(unpaint(rows[4]), /^│ +13 │ return total +│$/u, unpaint(rows[4]));
    // A changed row is divided too, and its divider is part of the row's ONE role, not its own paint.
    assert.ok(rows[2].includes('<toolDiffRemoved>-12 │ const total = 1</toolDiffRemoved>'), rows[2]);
    assert.equal(rows[2].includes('<dim>'), false, 'a changed row has no colour of its own but its role');
  });

  test('the divider is measured as PLAIN text, so the row keeps the width the host gave it', () => {
    // A row whose code already fills it: the two columns the divider needs come out of the CODE.
    const code = 'for (const item of items) sum += item.price;';
    const tight = `│ -12 ${code} │`;
    const rows = diffColorDesign(seamFor().seam).apply([tight], ctx());
    assert.equal(cols(rows[0]), cols(tight), 'the row keeps the width the host gave it');
    const plain = unpaint(rows[0]);
    assert.equal((plain.match(/│/gu) ?? []).length, 3, `two frame cells and ONE divider: ${plain}`);
    assert.ok(plain.startsWith('│ -12 │ for (const item of items) sum += item.pric'), plain);
    assert.ok(plain.includes('…'), 'the code was clipped to what the divider left');
    assert.equal(plain.includes('item.price;'), false, 'what did not fit is clipped, never wrapped or pushed out');
  });

  test('a clipped context row is drawn plain, never cut out of a painted row', () => {
    const { seam, asked } = seamFor();
    const row = `│  12 const value = ${'x'.repeat(44)} │`;
    const rows = diffColorDesign(seam).apply([row], ctx());
    assert.equal(cols(rows[0]), cols(row), 'the row keeps the width the host gave it');
    assert.ok(unpaint(rows[0]).includes('…'), 'the row ends in the ellipsis the clip wrote');
    assert.equal(rows[0].includes('\u001b[36m'), false, 'a clipped line is drawn plain, never cut out of a paint');
    assert.equal(rows[0].includes('<text>'), true, rows[0]);
    assert.equal(asked.length, 0, 'no painted line was measured or clipped');
  });

  test('a row too narrow to hold the gutter keeps the host\'s drawing whole', () => {
    const row = '│ -4 x │';
    const out = diffColorDesign(seamFor().seam).apply([row], ctx());
    assert.deepEqual(out, [row], 'the divider is never added by overflowing the row');
  });

  test('a hunk header and a skip marker state no line, so neither is divided', () => {
    const hunk = '│ @@ -1,4 +1,4 @@                     │';
    const skip = '│    ...                                │';
    const [outHunk, outSkip] = diffColorDesign(seamFor().seam).apply([hunk, skip], ctx());
    assert.equal(outSkip, skip, 'a skip marker is not a diff row and is left as drawn');
    assert.equal(unpaint(outHunk), unpaint(hunk), 'a hunk header states the same text');
    assert.match(outHunk, /<muted>@@ -1,4 \+1,4 @@<\/muted>/u);
  });
});

describe('a changed row is painted whole, as `git diff` paints it (S13)', () => {
  const ctx = () => ({ tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'lib/app.js' } } });
  const card = [
    '│ -12 const total = 1                   │',
    '│ +12 const total = 2                   │',
  ];

  test('a removed row is ENTIRELY the removed role: marker, number, divider and code', () => {
    const [removed] = diffColorDesign(seamFor().seam).apply(card, ctx());
    assert.equal(removed, `│ <toolDiffRemoved>-12 │ const total = 1</toolDiffRemoved>${' '.repeat(17)}│`);
  });

  test('an added row is ENTIRELY the added role', () => {
    const added = diffColorDesign(seamFor().seam).apply(card, ctx())[1];
    assert.equal(added, `│ <toolDiffAdded>+12 │ const total = 2</toolDiffAdded>${' '.repeat(17)}│`);
  });

  test('the highlighter is never asked for a changed row\'s code', () => {
    const { seam, asked } = seamFor();
    diffColorDesign(seam).apply([...card, '│  13 return total                      │'], ctx());
    assert.deepEqual(asked.map(([code]) => code), ['return total'], 'only the context row is the highlighter\'s');
  });

  test('the host\'s intra-line emphasis is replaced by the role, so the row reads as one colour', () => {
    // `renderDiff` puts `theme.inverse(...)` runs around the words that changed, INSIDE the role's
    // paint. A whole-row role has no span to emphasise, and keeping them would make a second pass
    // (which rebuilds the row from its plain text) differ from the first.
    const emphasised = '│ -12 const \u001b[7mtotal\u001b[27m = 1   │';
    const [row] = diffColorDesign(undefined).apply([emphasised], { ...ctx(), theme: { fg: (role, text) => `<${role}>${text}</${role}>` } });
    assert.equal(row.includes('\u001b[7m'), false, 'no inverse run survives: the role is the whole row');
    assert.equal(unpaint(row).includes('const total = 1'), true, 'the text itself is kept');
  });

  test('a context row keeps today\'s drawing, so the change is the changed rows alone', () => {
    const { seam, asked } = seamFor();
    const [row] = diffColorDesign(seam).apply(['│  13 return total                      │'], ctx());
    assert.deepEqual(asked.map(([code]) => code), ['return total']);
    assert.ok(row.includes(`<muted>13</muted> <dim>│</dim> ${HIGHLIGHT('return total')}`), row);
  });
});

// S8b: a row already wearing this paint comes back BYTE-IDENTICAL. The markup theme above states
// the role's NAME (`<toolDiffAdded>`), which the parser reads as the row's own text, so it can
// never show an escape added twice; only a real theme, whose `fg` answers SGR codes, can.
describe('repainting a row it already painted is a byte-identical no-op (S8b/S14)', () => {
  const SGR_ROLE = { toolDiffAdded: '92', toolDiffRemoved: '91', muted: '90', dim: '2', text: '39' };
  const sgr = (role, text) => `\u001b[${SGR_ROLE[role] ?? '39'}m${text}\u001b[39m`;
  const sgrTheme = { fg: (role, text) => sgr(role, text) };
  // The host's own edit body rows, at the layout its `renderDiff` draws them
  // (`dist/core/tools/edit-diff.js:356,362,377`: `${marker}${padded number} ${code}`), between the
  // card's own painted frame cells and padded out to the card's width.
  const FRAME = '\u001b[32m│\u001b[39m';
  const hostRow = (text, pad = 8) => `${FRAME} ${text}${' '.repeat(pad)} ${FRAME}`;
  const hostPainted = [
    hostRow('@@ -1,4 +1,4 @@'),
    hostRow('\u001b[91m- 4 const stale = 3;\u001b[39m'),
    hostRow('\u001b[92m+ 4 const fresh = 4;\u001b[39m'),
    hostRow('  4 const kept = 2;'),
  ];
  // A row's own text with its frame and padding removed: the divider is then the only difference a
  // pass may make to what a row says.
  const interior = (row) => unpaint(row).replace(/^│ +/u, '').replace(/ *│$/u, '');
  const DIVIDED = ['@@ -1,4 +1,4 @@', '- 4 │ const stale = 3;', '+ 4 │ const fresh = 4;', '4 │ const kept = 2;'];
  const escapes = (row) => row.match(/\u001b\[[0-9;]*m/gu) ?? [];

  for (const [name, seam] of [['no highlighter', undefined], ['a real highlighter', seamFor().seam]]) {
    test(`${name}: four passes over its own rows add no escape, no reset and no second divider`, () => {
      const design = diffColorDesign(seam);
      const ctx = { tool: 'edit', part: 'call', width: WIDTH, theme: sgrTheme, render: { args: { path: 'lib/app.js' } } };
      const passes = [];
      let rows = hostPainted;
      for (let pass = 0; pass < 4; pass += 1) {
        rows = design.apply(rows, ctx);
        passes.push(rows);
      }
      for (const [pass, seen] of passes.entries()) {
        assert.deepEqual(seen, passes[0], `pass ${pass + 1} is a byte-identical no-op`);
        for (const [index, row] of seen.entries()) {
          assert.equal(cols(row), cols(hostPainted[index]), `row ${index} keeps its width`);
          assert.deepEqual(escapes(row), escapes(passes[0][index]), `row ${index} gains no escape`);
        }
      }
      assert.deepEqual(passes[0].map(interior), DIVIDED, 'one divider per row, never two');
      // The defect this pins: the added row's opening code used to survive in the prefix and be
      // issued again, so a second pass read `\u001b[92m\u001b[92m`. No escape is ever issued twice
      // in a row here — the row is rebuilt from its plain text, never stacked on the paint already
      // there.
      assert.doesNotMatch(passes[0][2], /\u001b\[([0-9;]*)m\u001b\[\1m/u, passes[0][2]);
      assert.doesNotMatch(passes[0][1], /\u001b\[([0-9;]*)m\u001b\[\1m/u, passes[0][1]);
      // The host's own frame cells keep their paint, on every pass.
      assert.ok(passes[0][2].startsWith(`${FRAME} `), passes[0][2]);
      assert.ok(passes[0][2].endsWith(` ${FRAME}`), passes[0][2]);
    });
  }

  test('a row with no padding gives up code, never the frame, and only once', () => {
    const design = diffColorDesign(undefined);
    const ctx = { tool: 'edit', part: 'call', width: WIDTH, theme: sgrTheme, render: { args: { path: 'lib/app.js' } } };
    // The card's width is already spent: the two columns the divider needs come out of the code.
    const full = `${FRAME} -12 for (const item of items) sum += item.price; ${FRAME}`;
    const once = design.apply([full], ctx);
    assert.equal(cols(once[0]), cols(full), 'the frame is not pushed out');
    assert.match(interior(once[0]), /^-12 │ for \(const item of items\) sum \+= item\.pric…$/u, interior(once[0]));
    assert.ok(interior(once[0]).endsWith('…'), 'what did not fit is clipped');
    assert.deepEqual(design.apply(once, ctx), once, 'the clip fills the row, so the next pass is a no-op');
  });

  test('the plainest host row is a no-op too: a real theme never doubles the marker paint', () => {
    const design = diffColorDesign(undefined);
    const ctx = { tool: 'edit', part: 'call', width: WIDTH, theme: sgrTheme, render: { args: { path: 'lib/app.js' } } };
    const rows = ['│ +4 const fresh = 4;     │'];
    const once = design.apply(rows, ctx);
    assert.equal(once[0], `│ ${sgr('toolDiffAdded', '+4 │ const fresh = 4;')}   │`);
    assert.deepEqual(design.apply(once, ctx), once);
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
    assert.match(edit[2], /<toolDiffRemoved>-12 │ const total = 1<\/toolDiffRemoved>/u, 'the diff role carries the code');
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

describe('a diff line the host wrapped is ONE row ending in an ellipsis, as the write pane draws it (S15)', () => {
  const ctx = () => ({ tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'lib/app.js' } } });
  // The host's `Text` breaks a long diff line at the width: the first row states the number, every
  // other row is the rest of the SAME line, at the row's own left column with no number.
  const INNER = WIDTH - 4;
  const hostWrap = (marker, number, code) => {
    // Word wrap; a word longer than the row is broken through, which fills the row.
    const rows = [];
    let current = '';
    for (let word of `${marker}${number} ${code}`.split(' ')) {
      if (current !== '' && textLength(`${current} ${word}`) > INNER) {
        rows.push(current);
        current = '';
      }
      while (textLength(word) > INNER) {
        if (current !== '') rows.push(current);
        rows.push(word.slice(0, INNER));
        current = '';
        word = word.slice(INNER);
      }
      current = current === '' ? word : `${current} ${word}`;
    }
    rows.push(current);
    return rows.map((row) => `│ ${row.padEnd(INNER)} │`);
  };
  const textLength = (text) => Array.from(text).length;
  const LONG = 'const mentions = source.split(newline).filter((line) => !/oddModules/.test(line) && /codegraph/i.test(line))';

  test('an added line: the rest rows are dropped and the one row keeps its width, divider and role', () => {
    const wrapped = hostWrap('+', '233', LONG);
    assert.ok(wrapped.length >= 2, 'the host did wrap this line');
    const rows = diffColorDesign(seamFor().seam).apply(wrapped, ctx());
    assert.equal(rows.length, 1, `the wrapped remainder is not drawn as stray rows: ${rows.map(unpaint).join('\n')}`);
    assert.equal(cols(rows[0]), WIDTH, 'the row keeps the width the host gave it');
    const plain = unpaint(rows[0]);
    assert.match(plain, /^│ \+233 │ const mentions = .*…\s*│$/u, plain);
    assert.match(rows[0], /<toolDiffAdded>\+233 │ .*…<\/toolDiffAdded>/u, 'the whole row still wears the role');
    assert.equal((plain.match(/│/gu) ?? []).length, 3, `two frame cells and ONE divider: ${plain}`);
  });

  test('a removed and a context line behave the same, and the rows around them are untouched', () => {
    const rows = diffColorDesign(seamFor().seam).apply([
      `│ ${'@@ -230,3 +230,3 @@'.padEnd(INNER)} │`,
      ...hostWrap('-', '232', LONG),
      ...hostWrap(' ', '234', LONG),
      `│ ${'+235 const next = 1;'.padEnd(INNER)} │`,
    ], ctx());
    const plain = rows.map(unpaint);
    assert.equal(plain.length, 4, plain.join('\n'));
    assert.match(plain[1], /^│ -232 │ const mentions = .*…\s*│$/u);
    assert.match(plain[2], /^│ +234 │ const mentions = .*…\s*│$/u);
    assert.match(plain[3], /^│ \+235 │ const next = 1;\s*│$/u, 'a line that fit is not marked');
    for (const row of rows) assert.equal(cols(row), WIDTH);
  });

  test('a word longer than the width is cut the same way, and nothing wraps past the frame', () => {
    const rows = diffColorDesign(seamFor().seam).apply(hostWrap('+', '9', 'x'.repeat(130)), ctx());
    assert.equal(rows.length, 1);
    assert.equal(cols(rows[0]), WIDTH);
    assert.match(unpaint(rows[0]), /^│ \+9 │ x+…\s*│$/u);
  });

  test('painted twice is the same rows', () => {
    const design = diffColorDesign(seamFor().seam);
    const once = design.apply(hostWrap('+', '233', LONG), ctx());
    assert.deepEqual(design.apply(once, ctx()), once);
  });

  test('only the rest of a line is dropped: a skip marker, the closing rule and a hint stay', () => {
    const rows = [
      ...hostWrap('+', '233', LONG),
      '│    ...                                                   │',
      '╰──────────────────────────────────────────────────────────╯',
      'ctrl+o to expand',
    ];
    const plain = diffColorDesign(seamFor().seam).apply(rows, ctx()).map(unpaint);
    assert.equal(plain.length, 4, plain.join('\n'));
    assert.equal(plain[1], rows[hostWrap('+', '233', LONG).length]);
    assert.equal(plain[2], rows.at(-2));
    assert.equal(plain[3], 'ctrl+o to expand');
  });
});

describe('the edit heading states what the call changed, as the write heading states its lines (S16)', () => {
  const heading = '╭─ ✎ edit lib/app.js ─────────────────────────────────────╮';
  const withHint = '╭─ ✎ edit lib/app.js ──────────────── ctrl+o to collapse ─╮';
  const run = (rows, edits, extra = {}) => diffColorDesign(seamFor().seam).apply(rows, {
    tool: 'edit',
    part: 'call',
    width: WIDTH,
    theme,
    render: { args: { path: 'lib/app.js', edits }, ...extra },
  });
  const edit = (oldText, newText) => ({ oldText, newText });

  test('added and removed lines follow the path, muted, and the row keeps its width', () => {
    const [row] = run([withHint], [edit('a\nb', 'a\nc\nd')]);
    assert.equal(cols(row), cols(withHint), 'the rule gave the columns, the frame did not move');
    assert.match(row, /edit lib\/app\.js <muted>\(\+2 · -1\)<\/muted> ─+ ctrl\+o to collapse ─╮$/u, row);
  });

  test('a count of zero is not written, and nothing changed writes nothing', () => {
    assert.match(run([heading], [edit('a', 'a\nb\nc')])[0], /<muted>\(\+2\)<\/muted>/u);
    assert.match(run([heading], [edit('a\nb', 'a')])[0], /<muted>\(-1\)<\/muted>/u);
    assert.equal(run([heading], [edit('same', 'same')])[0], heading);
  });

  test('every edit of the call counts, and the legacy single oldText/newText call too', () => {
    assert.match(run([heading], [edit('a', 'b'), edit('x\ny', 'x')])[0], /\(\+1 · -2\)/u);
    const legacy = diffColorDesign(seamFor().seam).apply([heading], {
      tool: 'edit', part: 'call', width: WIDTH, theme, render: { args: { path: 'lib/app.js', oldText: 'a', newText: 'b\nc' } },
    });
    assert.match(legacy[0], /\(\+2 · -1\)/u);
  });

  test('a line only counts when the call really changes it', () => {
    const [row] = run([heading], [edit('keep\nold\nkeep too', 'keep\nnew\nkeep too')]);
    assert.match(row, /\(\+1 · -1\)/u, row);
  });

  test('float and unframed headings carry the count too', () => {
    const float = ' ▎ ✎ edit lib/app.js                      ctrl+o to expand   ';
    assert.match(run([float], [edit('a', 'b')])[0], /edit lib\/app\.js <muted>\(\+1 · -1\)<\/muted> +ctrl\+o to expand/u);
    assert.equal(cols(run([float], [edit('a', 'b')])[0]), cols(float));
    const bare = `edit lib/app.js${' '.repeat(40)}`;
    assert.match(run([bare], [edit('a', 'b')])[0], /^edit lib\/app\.js <muted>\(\+1 · -1\)<\/muted> +$/u);
  });

  test('no room, no args, a failed call or the body rows: the host\'s rows come back', () => {
    const tight = '╭─ ✎ edit lib/app.js ─╮';
    assert.deepEqual(run([tight], [edit('a', 'b')]), [tight]);
    assert.deepEqual(run([heading], undefined), [heading]);
    assert.deepEqual(run([heading], [edit('a', 'b')], { isError: true }), [heading]);
    const body = ['│ -1 edit lib/app.js ──────────────────────────────────────  │'];
    assert.equal(unpaint(run(body, [edit('a', 'b')])[0]).includes('(+1 · -1)'), false);
  });

  test('painted twice is the same row', () => {
    const once = run([withHint], [edit('a', 'b')]);
    assert.deepEqual(run(once, [edit('a', 'b')]), once);
  });

  test('the colour the heading was drawn in is picked up again after the count', () => {
    const painted = `\u001b[34m${withHint}\u001b[39m`;
    const [row] = run([painted], [edit('a', 'b')]);
    assert.ok(row.includes('</muted>\u001b[34m'), row);
  });
});

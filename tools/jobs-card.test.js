'use strict';
// The jobs card: `bash_background`, `monitor`, `job_stop` and `job_list` are registered by
// Gentle Shell with no renderer of their own, so Pi draws its plain default box and the
// conversation's card style never reaches them. While the bridge's `Card tags` line answers
// `activity` for the tool being drawn, this package draws them on its own card substrate
// (`lib/shell-card.js`), in whichever style the shell has chosen. Any other answer — and the
// absence of an answer — leaves Pi's own drawing exactly as it was.
//
// Every case goes through the public surface: the resolver, the slots it returns and the
// rows a component draws for a width. The text seam and the themes are the fakes
// `tools/file-card.test.js` uses; the bridge is the published object a process-wide slot holds.
const assert = require('node:assert/strict');
const { after, afterEach, beforeEach, test } = require('node:test');

const { JOB_TOOLS } = require('../lib/jobs-card.js');
const { createJobsCardResolver, registerJobsCard } = require('../lib/jobs-card-resolver.js');
const { applyBashActivityHeading, toolsActivityDesign } = require('../lib/bash-design.js');
const { CARD_CONTENT, CARD_CONTENT_SLOT } = require('../lib/card-content.js');
const { CARD_STYLE, CARD_STYLE_SLOT } = require('../lib/card-style.js');

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI, '');
const chars = (value) => [...stripAnsi(value)];

const metrics = {
  visibleWidth: (value) => chars(value).length,
  truncateToWidth(value, width, ellipsis = '') {
    if (width <= 0) return '';
    if (this.visibleWidth(value) <= width) return value;
    const tail = ellipsis ?? '';
    return chars(value).slice(0, Math.max(0, width - [...tail].length)).join('') + tail;
  },
  wrapTextWithAnsi(value, width) {
    const text = stripAnsi(value);
    if (width <= 0) return [text];
    return text.split('\n').flatMap((line) => {
      const lines = [];
      let current = '';
      for (const word of line.split(' ')) {
        const candidate = current === '' ? word : `${current} ${word}`;
        if ([...candidate].length <= width) { current = candidate; continue; }
        if (current !== '') { lines.push(current); current = ''; }
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
const taggedTheme = { fg: (role, value) => `<${role}>${value}</${role}>` };
const bandTheme = { fg: (_role, value) => value, bg: (_role, value) => `\x1b[48;5;240m${value}\x1b[49m` };
const unpaint = (value) => stripAnsi(value).replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, '');

const BRIDGE_API_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const ACTIVITY = Object.freeze({ kind: 'design', design: { id: 'odd-worktree.bash-activity' } });

beforeEach(() => {
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  delete globalThis[CARD_CONTENT_SLOT];
  delete globalThis[BRIDGE_API_SLOT];
});
afterEach(() => { delete globalThis[BRIDGE_API_SLOT]; });
after(() => {
  delete globalThis[CARD_STYLE_SLOT];
  delete globalThis[CARD_CONTENT_SLOT];
  delete globalThis[BRIDGE_API_SLOT];
});

function publishBridge(selection, asked) {
  const api = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    VERSION: '0.10.0',
    registerToolDesign: () => () => {},
    resolveToolDesignSelection(tool) {
      if (asked !== undefined) asked.push(tool);
      if (typeof selection === 'function') return selection(tool);
      return selection;
    },
  };
  globalThis[BRIDGE_API_SLOT] = api;
  return api;
}

function jobsResolver(options) {
  const registered = [];
  const cards = createJobsCardResolver({ metrics, theme: plainTheme, registerToolRenderer: (resolver) => registered.push(resolver), ...options });
  assert.equal(cards.registered, true);
  assert.equal(registered.length, 1);
  return registered[0];
}

// What Pi would have drawn for a tool with no renderer of its own: whatever `next()` says.
const PI_DEFAULT = Object.freeze({ marker: 'pi default' });

const COMMAND = 'sleep 20; until [ "$(gh run list --repo acme/api)" ]; do sleep 1; done';
const LABEL = 'Release runs for 1.9.1';
const STARTED = [
  'Started background job job-2 ("Release runs for 1.9.1").',
  'Output: /tmp/gentle-jobs-1018kZ/job-2.log',
  'You will be notified once when it exits; keep working or end your turn. Stop it with job_stop.',
].join('\n');

const slots = (resolver, tool) => resolver(tool, () => PI_DEFAULT);
const callRows = (resolver, tool, args, theme, width = 70, context = { isPartial: false }) =>
  slots(resolver, tool).renderCall(args, theme, { args, ...context }).render(width);
const resultRows = (resolver, tool, args, text, options = { isPartial: false }, theme = plainTheme, width = 70, context = {}) =>
  slots(resolver, tool).renderResult({ content: [{ type: 'text', text }], details: {} }, options, theme, { args, state: {}, ...context }).render(width);

function assertFramed(rows, width) {
  for (const row of rows) assert.equal(metrics.visibleWidth(unpaint(row)), width, `"${unpaint(row)}" is not ${width} wide`);
}

// ---- the one switch ----

test('the card is drawn only while the Card tags line answers activity; every other answer leaves Pi\'s own drawing', () => {
  const answers = [
    ['no bridge published', undefined],
    ['the bridge\'s native answer', { kind: 'native' }],
    ['a tool the line does not cover', { kind: 'not-covered' }],
    ['a design that has left the line', { kind: 'missing' }],
    ['another plugin\'s design', { kind: 'design', design: { id: 'acme.tools' } }],
    ['an answer nothing can read', 'garbage'],
  ];
  for (const [name, answer] of answers) {
    if (answer !== undefined) publishBridge(answer);
    for (const tool of JOB_TOOLS) assert.equal(slots(jobsResolver(), tool), PI_DEFAULT, `${name}: ${tool}`);
    delete globalThis[BRIDGE_API_SLOT];
  }
  // A bridge too old to carry the reader, and one whose reader throws, are no answer either.
  globalThis[BRIDGE_API_SLOT] = { schema: 'gentle-shell-bridge/api', version: 1, VERSION: '0.6.0', registerToolDesign: () => () => {} };
  assert.equal(slots(jobsResolver(), 'bash_background'), PI_DEFAULT);
  publishBridge(() => { throw new Error('boom'); });
  assert.equal(slots(jobsResolver(), 'bash_background'), PI_DEFAULT);
});

test('while activity is selected the four job tools get a self-framed card and the bridge is asked per tool', () => {
  const asked = [];
  publishBridge(ACTIVITY, asked);
  const resolver = jobsResolver();
  for (const tool of JOB_TOOLS) {
    const drawn = slots(resolver, tool);
    assert.notEqual(drawn, PI_DEFAULT, tool);
    assert.equal(drawn.renderShell, 'self', `${tool} frames itself`);
    assert.equal(typeof drawn.renderCall, 'function');
    assert.equal(typeof drawn.renderResult, 'function');
  }
  assert.deepEqual(asked, [...JOB_TOOLS]);
});

test('no other tool is ever claimed: bash, the file tools and an unknown tool come back as the chain resolved them', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  for (const tool of ['bash', 'read', 'write', 'edit', 'grep', 'codemode', 'job_unknown']) {
    assert.equal(slots(resolver, tool), PI_DEFAULT, tool);
  }
});

// ---- the call ----

test('a background job heads with its mark, its label and nothing it did not state', () => {
  publishBridge(ACTIVITY);
  const rows = callRows(jobsResolver(), 'bash_background', { command: COMMAND, label: LABEL }, taggedTheme);
  assert.equal(rows.length, 1, 'collapsed, a finished call is one rule');
  const text = unpaint(rows[0]);
  assert.match(text, /^╭─ ⧗ bash background · Release runs for 1\.9\.1 /u, text);
  assert.match(text, /╮$/u);
  assert.ok(rows[0].includes('<bashMode>⧗</bashMode>'), 'the mark wears the identity role');
  assert.doesNotMatch(text, /sleep 20/u, 'the command waits for the expanded view');
  assertFramed(rows, 70);
});

test('without a label the first line of the command names the job; the other tools name their target', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  assert.match(unpaint(callRows(resolver, 'bash_background', { command: '\n  npm test --silent\nnpm run lint' }, plainTheme)[0]), /⧗ bash background · npm test --silent/u);
  assert.match(unpaint(callRows(resolver, 'monitor', { command: 'tail -f app.log', label: 'app log', timeout_seconds: 60 }, plainTheme)[0]), /⧗ bash monitor · app log/u);
  assert.match(unpaint(callRows(resolver, 'job_stop', { job_id: 'job-2' }, plainTheme)[0]), /■ stop · job-2/u);
  assert.match(unpaint(callRows(resolver, 'job_list', {}, plainTheme)[0]), /≡ jobs · this session/u);
});

test('both job tools wear one mark and one role, so a monitor reads as a background job', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  const background = callRows(resolver, 'bash_background', { command: COMMAND, label: LABEL }, taggedTheme)[0];
  const monitor = callRows(resolver, 'monitor', { command: COMMAND, label: LABEL, timeout_seconds: 60 }, taggedTheme)[0];
  for (const row of [background, monitor]) assert.ok(row.includes('<bashMode>⧗</bashMode>'), 'the mark wears the identity role');
  assert.match(unpaint(background), /⧗ bash background ·/u);
  assert.match(unpaint(monitor), /⧗ bash monitor ·/u);
});

test('the two bash tools keep the role on the frame and the name, and mute the input text', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  const background = callRows(resolver, 'bash_background', { command: COMMAND, label: LABEL }, taggedTheme)[0];
  const monitor = callRows(resolver, 'monitor', { command: COMMAND, label: LABEL, timeout_seconds: 60 }, taggedTheme)[0];
  for (const row of [background, monitor]) {
    assert.ok(row.includes('<bashMode>'), 'the frame and the mark keep the identity role');
    assert.ok(row.includes('<muted>'), 'the input text — the label — is muted');
    assert.ok(!row.includes('<accent>'), 'and it is not the accent the other two tools keep');
  }
});

test('expanded, the whole command is stated below the heading, every line of it', () => {
  publishBridge(ACTIVITY);
  const rows = callRows(jobsResolver(), 'bash_background', { command: 'sleep 20\n\ngh run list --repo acme/api', label: LABEL }, plainTheme, 70, { isPartial: false, expanded: true }).map(unpaint);
  const joined = rows.join('\n');
  assert.match(joined, /Release runs for 1\.9\.1/u);
  assert.match(joined, /│ sleep 20 +│/u);
  assert.match(joined, /│ gh run list --repo acme\/api +│/u);
  assertFramed(rows, 70);
});

test('a call still waiting for its result closes its own frame; once the result exists the result closes it', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  const state = {};
  const running = slots(resolver, 'bash_background').renderCall({ command: COMMAND }, plainTheme, { isPartial: true, state }).render(70).map(unpaint);
  assert.match(running.join('\n'), /running/iu);
  assert.match(running.at(-1), /^╰/u, 'the running call closes itself');
  const settled = callRows(resolver, 'bash_background', { command: COMMAND }, plainTheme, 70, { isPartial: false }).map(unpaint);
  assert.doesNotMatch(settled.join('\n'), /^╰/mu, 'the result owns the closing rule');
});

// ---- the result ----

test('the result previews the first rows collapsed, everything expanded, and always closes the frame', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  const collapsed = resultRows(resolver, 'bash_background', { command: COMMAND }, `${STARTED}\nextra line four`).map(unpaint);
  assert.match(collapsed.join('\n'), /Started background job job-2/u);
  assert.doesNotMatch(collapsed.join('\n'), /extra line four/u, 'only the preview budget is drawn collapsed');
  assert.match(collapsed.at(-1), /^╰/u);
  const expanded = resultRows(resolver, 'bash_background', { command: COMMAND }, `${STARTED}\nextra line four`, { isPartial: false, expanded: true }).map(unpaint);
  assert.match(expanded.join('\n'), /extra line four/u);
  assert.match(expanded.at(-1), /^╰/u);
});

test('the minimal card content level draws the call alone, but a failure still says why', () => {
  publishBridge(ACTIVITY);
  globalThis[CARD_CONTENT_SLOT] = CARD_CONTENT.MINIMAL;
  const resolver = jobsResolver();
  const quiet = resultRows(resolver, 'bash_background', { command: COMMAND }, STARTED).map(unpaint);
  assert.doesNotMatch(quiet.join('\n'), /Started background job/u);
  assert.match(quiet.at(-1), /^╰/u, 'the frame still closes');
  const failed = resultRows(resolver, 'job_stop', { job_id: 'job-9' }, 'No background job job-9 in this session.', { isPartial: false }, plainTheme, 70, { isError: true }).map(unpaint);
  assert.match(failed.join('\n'), /No background job job-9 in this session\./u);
});

// ---- the style and the width ----

test('neon draws the outlined frame and float the borderless rail, whichever tool is drawn', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  for (const tool of JOB_TOOLS) {
    const args = tool === 'job_stop' ? { job_id: 'job-2' } : tool === 'job_list' ? {} : { command: COMMAND, label: LABEL };
    globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
    const neon = [...callRows(resolver, tool, args, bandTheme), ...resultRows(resolver, tool, args, STARTED, { isPartial: false }, bandTheme)].map(unpaint);
    assert.match(neon[0], /^╭/u, `${tool} neon`);
    assert.match(neon.at(-1), /^╰/u);
    globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
    const float = [...callRows(resolver, tool, args, bandTheme), ...resultRows(resolver, tool, args, STARTED, { isPartial: false }, bandTheme)].map(unpaint);
    assert.doesNotMatch(float.join('\n'), /[╭╮╰╯]/u, `${tool} float draws no box`);
    assert.match(float.join('\n'), /▎/u);
  }
});

test('every row fits the width the host asked for, at narrow and wide terminals', () => {
  publishBridge(ACTIVITY);
  const resolver = jobsResolver();
  for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
    globalThis[CARD_STYLE_SLOT] = style;
    for (const width of [24, 40, 70, 120]) {
      const rows = [
        ...callRows(resolver, 'bash_background', { command: COMMAND, label: LABEL }, bandTheme, width),
        ...callRows(resolver, 'bash_background', { command: COMMAND, label: LABEL }, bandTheme, width, { isPartial: false, expanded: true }),
        ...resultRows(resolver, 'bash_background', { command: COMMAND }, STARTED, { isPartial: false, expanded: true }, bandTheme, width),
      ];
      assertFramed(rows, width);
    }
  }
});

// ---- the wiring ----

test('registerJobsCard hands one resolver to the host hook and reports a host that has none', () => {
  const handed = [];
  const outcome = registerJobsCard({ registerToolRenderer: (resolver) => handed.push(resolver) }, { metrics });
  assert.equal(outcome.registered, true);
  assert.equal(handed.length, 1);
  assert.deepEqual(registerJobsCard({}, { metrics }), { registered: false, resolver: undefined });
});

test('the Card tags line covers the four job tools, so the bridge can answer for them', () => {
  for (const scopes of [true, false]) {
    const design = toolsActivityDesign({ scopes });
    for (const tool of JOB_TOOLS) assert.ok(design.tools.includes(tool), `${tool} (scopes: ${scopes})`);
    for (const tool of ['bash', 'grep', 'find', 'ls', 'read', 'write']) assert.ok(design.tools.includes(tool), `${tool} stays covered`);
  }
});

test('declaring the job tools on the line changes nothing the activity design draws: their rows come back exactly as given', () => {
  const rows = ['\x1b[2m bash_background command="sleep 20" \x1b[22m', ' Started background job job-2. '];
  for (const tool of JOB_TOOLS) {
    for (const part of ['call', 'result']) {
      const drawn = applyBashActivityHeading(rows, { width: 60, tool, theme: plainTheme, part, render: { args: { command: 'sleep 20' }, isPartial: false } });
      assert.deepEqual(drawn, rows, `${tool} ${part}`);
    }
  }
});

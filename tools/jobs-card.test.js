'use strict';
// The jobs card: `bash_background`, `monitor`, `job_stop` and `job_list` are registered by
// Gentle Shell with no renderer of their own, so Pi draws its plain default box and the
// conversation's card style never reaches them. While the bridge's `Card activity` line answers
// `activity` for the tool being drawn, this package draws them on its own card substrate
// (`lib/shell-card.js`), in whichever style the shell has chosen. Any other answer — and the
// absence of an answer — draws what Pi draws for a tool with no renderer, inside the card that
// was already mounted.
//
// The answer is read on EVERY paint, inside the component the host already mounted, because Pi
// resolves a tool's renderers once (`interactive-mode.js`: `getRegisteredToolDefinition` goes
// into `ToolExecutionComponent` at construction) and never asks again. That is what makes a
// flipped `Card activity` line repaint the cards already on screen, exactly as it does for
// `bash`, and the cases below drive it that way: one mounted component, repainted.
//
// Every case goes through the public surface: the resolver, the slots it returns and the
// rows a component draws for a width. The text seam and the themes are the fakes
// `tools/file-card.test.js` uses; the bridge is the published object a process-wide slot holds.
//
// The rows the card hands back while the line says anything else are compared byte for byte
// with Pi's own drawing, reproduced here from the host's source (`tool-execution.js`,
// `render-utils.js`) and independently of this package's implementation.
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

// ---- Pi's own drawing for a tool with a definition and no renderer ----
//
// Reproduced from the host's source and independently of this package: `contentBox` is
// `new Box(1, 1, bgFn)` with the `outputPad` columns of horizontal padding, `addChild`s
// `createCallFallback()` — `formatToolCallWithArgs(toolName, args, theme, expanded)` — and,
// once the result exists, `createResultFallback()`; `Box.render` draws one painted blank row
// above, the children at `width - pad * 2` padded to the full width, and one blank below.
const hostTheme = {
  fg: (role, value) => `<${role}>${value}</${role}>`,
  bg: (role, value) => `<${role}>${value}</${role}>`,
  bold: (value) => `<bold>${value}</bold>`,
};

/** `formatToolCallWithArgs`: the bold name, then `key=value` pairs — or one `key: value` row each. */
function piCallText(tool, args, expanded) {
  const header = hostTheme.fg('toolTitle', hostTheme.bold(tool));
  if (args === null || args === undefined) return header;
  const entries = typeof args === 'object' && !Array.isArray(args) ? Object.entries(args) : [['args', args]];
  if (entries.length === 0) return header;
  if (expanded) {
    const lines = entries.map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
      return `  ${key}: ${text.replace(/\t/g, '   ').replace(/\r/g, '').split('\n').join('\n    ')}`;
    });
    return `${header}\n${hostTheme.fg('muted', lines.join('\n'))}`;
  }
  const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(' ');
  const preview = pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs;
  return `${header} ${hostTheme.fg('muted', preview)}`;
}

// The host's own readers for a result's text (`dist/utils/ansi.js`: `stripAnsi`;
// `dist/utils/shell.js`: `sanitizeBinaryOutput`; then `\r` goes), transcribed from the host's
// source so the fallback rows can be compared byte for byte. Note what the host KEEPS: DEL
// (U+007F) is not in its list, and U+FFF9–U+FFFB are removed like binary controls.
const PI_ANSI = /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|(?:(?:\u001B\[|\u009B)[<=>]|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?)[\dA-PR-TZcf-nq-uy=><~]/g;
const PI_BINARY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFF9-\uFFFB]/g;
const piText = (value) => value.replace(PI_ANSI, '').replace(PI_BINARY, '').replace(/\r/g, '');

/** `createResultFallback`: the result's text, ten rows collapsed, and the host's own expand hint. */
function piResultText(result, context) {
  const output = result.content.filter((part) => part.type === 'text').map((part) => piText(part.text || '')).join('\n');
  if (output === '') return undefined;
  const lines = output.split('\n');
  const shown = context.expanded === true ? lines : lines.slice(0, 10);
  const remaining = lines.length - shown.length;
  const text = shown.map((line) => hostTheme.fg('toolOutput', line)).join('\n');
  if (remaining <= 0) return text;
  return `${text}${hostTheme.fg('muted', `\n... (${remaining} more lines,`)} ${context.keyHint('app.tools.expand', 'to expand')}${hostTheme.fg('muted', ')')}`;
}

/** `Text(text, 0, 0).render(width)`: tabs are three spaces, wrapped, every row padded to the width. */
function piTextRows(text, width) {
  if (text.trim() === '') return [];
  return metrics.wrapTextWithAnsi(text.replace(/\t/g, '   '), Math.max(1, width))
    .map((row) => row + ' '.repeat(Math.max(0, width - metrics.visibleWidth(row))));
}

/** The host's box around the given children, exactly as `Box.render` draws it for this state. */
function piBox(childTexts, width, context) {
  const pad = context.outputPad ?? 1;
  const role = context.isPartial !== false ? 'toolPendingBg' : context.isError === true ? 'toolErrorBg' : 'toolSuccessBg';
  const contentWidth = Math.max(1, width - pad * 2);
  const rows = childTexts.flatMap((text) => piTextRows(text, contentWidth));
  if (rows.length === 0) return [];
  const painted = (line) => hostTheme.bg(role, line + ' '.repeat(Math.max(0, width - metrics.visibleWidth(line))));
  return [painted(''), ...rows.map((row) => painted(' '.repeat(pad) + row)), painted('')];
}

/** The key hint the host paints into a fallback result, the same seam the cards read. */
const keyHint = (_id, text) => `[${text}]`;
const settled = { isPartial: false, expanded: false, outputPad: 1, keyHint };

/** What Pi draws for one settled job card: the call's fallback and the result's, in one box. */
function piSettledRows(tool, args, text, context, width) {
  const result = { content: [{ type: 'text', text }], details: {} };
  const children = [piCallText(tool, args, context.expanded === true)];
  const fallback = piResultText(result, context);
  if (fallback !== undefined) children.push(fallback);
  return piBox(children, width, context);
}

// ---- the one switch ----

test('every answer but activity draws what Pi draws for a tool with no renderer, byte for byte', () => {
  const answers = [
    ['no bridge published', undefined],
    ['the bridge\'s native answer', { kind: 'native' }],
    ['a tool the line does not cover', { kind: 'not-covered' }],
    ['a design that has left the line', { kind: 'missing' }],
    ['another plugin\'s design', { kind: 'design', design: { id: 'acme.tools' } }],
    ['an answer nothing can read', 'garbage'],
  ];
  const args = { command: COMMAND, label: LABEL };
  for (const [name, answer] of answers) {
    if (answer !== undefined) publishBridge(answer);
    for (const tool of JOB_TOOLS) {
      const callArgs = tool === 'job_stop' ? { job_id: 'job-2' } : tool === 'job_list' ? {} : args;
      const resolver = jobsResolver();
      const call = slots(resolver, tool).renderCall(callArgs, hostTheme, { args: callArgs, ...settled }).render(70);
      const result = slots(resolver, tool)
        .renderResult({ content: [{ type: 'text', text: STARTED }], details: {} }, settled, hostTheme, { args: callArgs, state: {}, ...settled })
        .render(70);
      assert.deepEqual([...call, ...result], piSettledRows(tool, callArgs, STARTED, settled, 70), `${name}: ${tool}`);
    }
    delete globalThis[BRIDGE_API_SLOT];
  }
  // A bridge too old to carry the reader, and one whose reader throws, are no answer either.
  globalThis[BRIDGE_API_SLOT] = { schema: 'gentle-shell-bridge/api', version: 1, VERSION: '0.6.0', registerToolDesign: () => () => {} };
  assert.deepEqual(
    [...callRows(jobsResolver(), 'bash_background', args, hostTheme, 70, settled), ...resultRows(jobsResolver(), 'bash_background', args, STARTED, settled, hostTheme, 70, settled)],
    piSettledRows('bash_background', args, STARTED, settled, 70),
    'a bridge older than the reader',
  );
  publishBridge(() => { throw new Error('boom'); });
  assert.deepEqual(
    [...callRows(jobsResolver(), 'bash_background', args, hostTheme, 70, settled), ...resultRows(jobsResolver(), 'bash_background', args, STARTED, settled, hostTheme, 70, settled)],
    piSettledRows('bash_background', args, STARTED, settled, 70),
    'a reader that throws',
  );
});

test('a call still running keeps the host\'s box closed below it, because no result follows yet', () => {
  publishBridge({ kind: 'native' });
  const args = { command: COMMAND };
  const running = callRows(jobsResolver(), 'bash_background', args, hostTheme, 60, { isPartial: true, outputPad: 1 });
  assert.deepEqual(running, piBox([piCallText('bash_background', args, false)], 60, { isPartial: true, outputPad: 1 }));
  assert.equal(metrics.visibleWidth(unpaint(running[0])), 60, 'the box paints its blank rows to the whole width');
});

test('a result that states nothing leaves the host\'s box closed, with no row of its own', () => {
  publishBridge({ kind: 'native' });
  const args = { job_id: 'job-2' };
  const resolver = jobsResolver();
  const call = callRows(resolver, 'job_stop', args, hostTheme, 50, settled);
  const result = resultRows(resolver, 'job_stop', args, '', settled, hostTheme, 50, settled);
  assert.deepEqual([...call, ...result], piSettledRows('job_stop', args, '', settled, 50), 'the host draws the box around the call alone');
  assert.deepEqual(result, [piBox([piCallText('job_stop', args, false)], 50, settled).at(-1)], 'the result half is that box\'s closing row');
});

/**
 * One pass of Pi's own component: the result half is BUILT when its update arrives (before the
 * pass), then the pass renders the call and the result inside the one box. The card is driven in
 * that same order, so a mark made while painting cannot hide behind the next frame.
 */
function piPass(resolver, tool, args, text, context, width) {
  const state = {};
  const options = { isPartial: context.isPartial === true, expanded: context.expanded === true };
  const result = slots(resolver, tool).renderResult({ content: [{ type: 'text', text }], details: {} }, options, hostTheme, { args, state, ...context });
  const call = slots(resolver, tool).renderCall(args, hostTheme, { args, state, ...context });
  return [...call.render(width), ...result.render(width)];
}

test('a PARTIAL result closes the host\'s box once, exactly as the host draws it', () => {
  publishBridge({ kind: 'native' });
  const partial = { isPartial: true, expanded: false, outputPad: 2, keyHint };
  const args = { command: 'tail -f app.log', label: 'app log' };
  const resolver = jobsResolver();
  assert.deepEqual(piPass(resolver, 'monitor', args, STARTED, partial, 84), piSettledRows('monitor', args, STARTED, partial, 84), 'the call waits while its result streams');
  // An empty partial result is no child at all: the box is the one around the call.
  assert.deepEqual(piPass(resolver, 'monitor', args, '', partial, 84), piSettledRows('monitor', args, '', partial, 84));
});

test('the host\'s own reader sanitizes a result, byte for byte', () => {
  publishBridge({ kind: 'native' });
  // A CSI colour, a BEL, the interlinear annotations the host strips, a CR and a DEL — which
  // the host's own list does NOT remove (`sanitizeBinaryOutput`).
  const raw = 'first \u001B[31mred\u001B[0m\uFFFB row\u0007\r\nsecond\u007F row';
  const args = { command: COMMAND };
  const resolver = jobsResolver();
  assert.deepEqual(piPass(resolver, 'bash_background', args, raw, settled, 70), piSettledRows('bash_background', args, raw, settled, 70));
  const drawn = piPass(resolver, 'bash_background', args, raw, settled, 70).join('\n');
  assert.doesNotMatch(unpaint(drawn), /\u001B|\uFFFB|\u0007/u, 'the host strips these');
  assert.match(unpaint(drawn), /second\u007F row/u, 'and the host keeps DEL, so the card keeps it too');
});

test('the four job tools are always the card\'s, and the line is read on every paint, never at build time', () => {
  const asked = [];
  publishBridge(ACTIVITY, asked);
  const resolver = jobsResolver();
  const slots_ = JOB_TOOLS.map((tool) => slots(resolver, tool));
  assert.deepEqual(asked, [], 'building the card asks nothing: Pi would never ask again');
  for (const [index, tool] of JOB_TOOLS.entries()) {
    const drawn = slots_[index];
    assert.notEqual(drawn, PI_DEFAULT, tool);
    assert.equal(drawn.renderShell, 'self', `${tool} frames itself`);
    assert.equal(typeof drawn.renderCall, 'function');
    assert.equal(typeof drawn.renderResult, 'function');
  }
  for (const [index, tool] of JOB_TOOLS.entries()) {
    const args = tool === 'job_stop' ? { job_id: 'job-2' } : tool === 'job_list' ? {} : { command: COMMAND };
    slots_[index].renderCall(args, plainTheme, { args, ...settled }).render(70);
    assert.deepEqual(asked.at(-1), tool, `${tool} is asked on its own name`);
    slots_[index].renderResult({ content: [{ type: 'text', text: STARTED }], details: {} }, settled, plainTheme, { args, state: {}, ...settled }).render(70);
    assert.deepEqual(asked.at(-1), tool, `${tool}'s result asks the same question`);
  }
  assert.equal(asked.length, JOB_TOOLS.length * 2, 'one question per painted slot, and no other');
});

test('a mounted card repaints when the line flips, in both directions', () => {
  const asked = [];
  publishBridge(ACTIVITY, asked);
  const resolver = jobsResolver();
  const args = { command: COMMAND, label: LABEL };
  // ONE card, mounted: the components the host built before any of this changed.
  const call = slots(resolver, 'bash_background').renderCall(args, hostTheme, { args, ...settled });
  const result = slots(resolver, 'bash_background')
    .renderResult({ content: [{ type: 'text', text: STARTED }], details: {} }, settled, hostTheme, { args, state: {}, ...settled });
  const on = { call: call.render(70), result: result.render(70) };
  assert.match(unpaint(on.call[0]), /⧗ bash background · Release runs/u, 'the card is drawn while the line says activity');
  // The line is turned off, and the SAME mounted components are repainted.
  publishBridge({ kind: 'native' });
  const off = { call: call.render(70), result: result.render(70) };
  assert.deepEqual([...off.call, ...off.result], piSettledRows('bash_background', args, STARTED, settled, 70), 'flipped off, the rows are the host\'s own');
  assert.doesNotMatch(unpaint(off.call.join('\n')), /⧗/u, 'the card\'s mark is gone');
  // And back on, from the same two components.
  publishBridge(ACTIVITY, asked);
  assert.deepEqual(call.render(70), on.call, 'flipped back on, the card is drawn again, unchanged');
  assert.deepEqual(result.render(70), on.result, 'the result half too');
  assert.equal(asked.length, 4, 'each paint of each half asked the line once: two paints on, and two back on');
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

test('the Card activity line covers the four job tools, so the bridge can answer for them', () => {
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

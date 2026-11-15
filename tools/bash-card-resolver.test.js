'use strict';
// S2/S5 (T4): the bash card's seam — the resolver this package registers through the
// host's `pi.registerToolRenderer((toolName, next) => ToolRenderers | undefined)` — and
// what it hands back for every row it does not own.
//
// Every case drives the public surface: the factory's `{ registered, resolver }`, the
// slots it returns, and the lines a component draws. Nothing reads module-internal
// state, a repository or a terminal, and no case spawns anything.
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, beforeEach, test } = require('node:test');

const { createBashCardResolver, registerBashCard } = require('../lib/bash-card-resolver.js');
const { createCodegraphCardResolver } = require('../lib/codegraph-card.js');
const { SHELL_ACTIVITIES, SHELL_ACTIVITY_IDENTITY } = require('../lib/bash-activity.js');
const { writeCardBashMode } = require('../lib/card-bash-mode.js');
const { CARD_STYLE } = require('../lib/card-style.js');

// ---- the injected seams ----

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI, '');
const columns = (value) => [...stripAnsi(value)].length;

const metrics = {
  visibleWidth: (value) => columns(value),
  truncateToWidth(value, width, ellipsis = '') {
    if (width <= 0) return '';
    if (columns(value) <= width) return value;
    const keep = Math.max(0, width - [...ellipsis].length);
    return [...stripAnsi(value)].slice(0, keep).join('') + ellipsis;
  },
  wrapTextWithAnsi(value, width) {
    const text = stripAnsi(value);
    if (width <= 0) return [text];
    const rows = [];
    for (const line of text.split('\n')) {
      const chars = [...line];
      while (chars.length > width) rows.push(chars.splice(0, width).join(''));
      rows.push(chars.join(''));
    }
    return rows;
  },
};

const plainTheme = { fg: (_role, value) => value };

/** A theme that tags every painted cell, so a case can see which role painted what. */
const taggedTheme = {
  fg(role, value) {
    return `<${role}>${value}</${role}>`;
  },
};

const CARD_STYLE_SLOT = Symbol.for('gentle-pi.card-style');
const CARD_BASH_MODE_SLOT = Symbol.for('gentle-pi.card-bash-mode');

const savedHome = process.env.GENTLE_PI_CONFIG_HOME;
const savedStyle = globalThis[CARD_STYLE_SLOT];
let configHome;

before(() => {
  configHome = mkdtempSync(join(tmpdir(), 'odd-worktree-bash-card-resolver-'));
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
});

// Every case starts with our card on and the live slot cleared: the mode is a
// process-wide slot, so a case that flipped it must never reach the next one.
beforeEach(() => {
  delete globalThis[CARD_BASH_MODE_SLOT];
});

after(() => {
  delete globalThis[CARD_BASH_MODE_SLOT];
  if (savedStyle === undefined) delete globalThis[CARD_STYLE_SLOT];
  else globalThis[CARD_STYLE_SLOT] = savedStyle;
  if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
  rmSync(configHome, { recursive: true, force: true });
});

/** Our card's own mode, set the way `/card:bash` sets it: the live slot. */
function setMode(mode) {
  globalThis[CARD_BASH_MODE_SLOT] = mode;
}

// ---- the hosts and the chains ----

/** A host that draws bash itself in the self shell the card substrate expects. */
const HOST_SELF = {
  renderShell: 'self',
  renderCall: () => ({ render: () => ['host bash call'], invalidate() {} }),
  renderResult: () => ({ render: () => ['host bash result'], invalidate() {} }),
};

/** A host whose bash row sits inside its own filled box (stock Pi's built-in renderer). */
const HOST_BOXED = {
  renderCall: () => ({ render: () => ['boxed host bash call'], invalidate() {} }),
  renderResult: () => ({ render: () => ['boxed host bash result'], invalidate() {} }),
};

function bashResolver(options) {
  const registered = [];
  const cards = createBashCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => registered.push(resolver),
    ...options,
  });
  return { ...cards, registered: cards.registered, hooks: registered };
}

function codegraphResolver(options) {
  const registered = [];
  createCodegraphCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => registered.push(resolver),
    ...options,
  });
  assert.equal(registered.length, 1);
  return registered[0];
}

/**
 * One row down a resolver chain: `first` sees `second`, and `second` sees `base`,
 * exactly as the host resolves extension resolvers in load order.
 */
const chain = (first, second, base) => first('bash', () => second('bash', () => base));

const textResult = (text) => ({ content: [{ type: 'text', text }], details: {} });

const callText = (slot, args, context = { isPartial: false }) => slot.renderCall(args, plainTheme, context).render(60).map(stripAnsi).join('\n');
const resultText = (slot, args, result, options = { isPartial: false }) => slot.renderResult(result, options, plainTheme, { args }).render(60).map(stripAnsi).join('\n');

// ---- the surface the factory hands the host ----

test('the factory registers one resolver through the host hook and returns it', () => {
  const cards = bashResolver();
  assert.equal(cards.registered, true);
  assert.deepEqual(cards.hooks, [cards.resolver], 'the hook receives this factory\'s resolver');

  const seen = [];
  const registered = createBashCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => seen.push(resolver),
  });
  assert.equal(registered.registered, true);
  assert.equal(seen[0], registered.resolver);
});

test('every tool that is not a bash call is handed back exactly as the chain resolved it', () => {
  const { resolver } = bashResolver();
  const hostRenderers = { renderShell: 'self', renderCall: () => 'host call', renderResult: () => 'host result' };
  for (const toolName of ['read', 'grep', 'edit', 'write', 'powershell', 'worktree_create', 'worktree_list', 'codegraph', 'mcp__codegraph__codegraph_explore', undefined, 42]) {
    assert.equal(resolver(toolName, () => hostRenderers), hostRenderers, `${String(toolName)} is the host's own row, byte for byte`);
  }
  // A chain that resolves nothing stays nothing: this package adds no renderer to an unrelated tool.
  assert.equal(resolver('read', () => undefined), undefined);
  // A chain whose next() throws is the host's own drawing, never a lost row.
  assert.equal(resolver('read', () => {
    throw new Error('chain exploded');
  }), undefined);
});

test('a bash call is ours when the card is on, and declares the self shell', () => {
  const { resolver } = bashResolver();
  const slot = resolver('bash', () => HOST_SELF);
  assert.equal(slot.renderShell, 'self', 'without self the host wraps the card in its own filled box');
  assert.equal(typeof slot.renderCall, 'function');
  assert.equal(typeof slot.renderResult, 'function');
  assert.match(callText(slot, { command: 'pnpm test' }), /✓ checking/);
});

// ---- S1/S6: the mode, read per paint ----

test('with the mode `default` the resolver steps aside for bash and hands back next()', () => {
  const cards = bashResolver();
  setMode('default');
  assert.equal(cards.resolver('bash', () => HOST_SELF), HOST_SELF, 'the host\'s own bash row, untouched');
  assert.equal(cards.resolver('bash', () => HOST_BOXED), HOST_BOXED, 'including a host that frames it itself');
  // The toggle is ours only: every other row is unaffected at either mode.
  const other = { renderCall: () => 'other' };
  assert.equal(cards.resolver('read', () => other), other);
});

test('the mode is read on every paint, so flipping /card:bash repaints a card already on screen', () => {
  const { resolver } = bashResolver();
  const slot = resolver('bash', () => HOST_SELF);
  // One component, drawn many times: no rebuild, no new resolver.
  const call = slot.renderCall({ command: 'pnpm test' }, plainTheme, { isPartial: false });
  const result = slot.renderResult(textResult('all green'), { isPartial: false }, plainTheme, { args: { command: 'pnpm test' } });
  const drawnCall = call.render(60).map(stripAnsi);
  const drawnResult = result.render(60).map(stripAnsi);
  assert.match(drawnCall.join('\n'), /✓ checking/, 'our card is drawn while the mode is own');

  setMode('default');
  try {
    assert.deepEqual(call.render(60).map(stripAnsi), ['host bash call'], 'the same call component now draws the host\'s row');
    assert.deepEqual(result.render(60).map(stripAnsi), ['host bash result'], 'and so does the result');
  } finally {
    delete globalThis[CARD_BASH_MODE_SLOT];
  }
  assert.deepEqual(call.render(60).map(stripAnsi), drawnCall, 'flipping back repaints our card again');
  assert.deepEqual(result.render(60).map(stripAnsi), drawnResult);
});

test('a mode written through the package\'s own writer is the mode the card paints', () => {
  const { resolver } = bashResolver();
  delete globalThis[CARD_BASH_MODE_SLOT];
  const saved = writeCardBashMode('default');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  try {
    delete globalThis[CARD_BASH_MODE_SLOT];
    assert.equal(resolver('bash', () => HOST_SELF), HOST_SELF, 'a row created while default is the host\'s own row');
  } finally {
    const restored = writeCardBashMode('own');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    // The writer publishes the slot on success; the next case must not inherit it.
    delete globalThis[CARD_BASH_MODE_SLOT];
  }
});

// ---- the seams the factory cannot work without ----

test('a missing or unusable metrics seam draws nothing of ours, and the host keeps the row', () => {
  // The measurement seam is part of the factory's contract, and the factory says which one is missing.
  assert.throws(() => createBashCardResolver(), /metrics/);
  assert.throws(() => createBashCardResolver({ registerToolRenderer: () => {} }), /metrics/);
  const broken = { ...metrics, wrapTextWithAnsi: undefined };
  assert.throws(() => createBashCardResolver({ metrics: broken }), /wrapTextWithAnsi/);

  // A seam resolved late (the host's TUI package is loaded inside the hook) is read per paint.
  const { resolver } = bashResolver({ metrics: () => metrics });
  assert.equal(resolver('bash', () => HOST_SELF).renderShell, 'self', 'a seam that resolves at paint time draws the card');

  // A seam that resolves to nothing at resolution time leaves the row to the host.
  for (const value of [() => undefined, () => null, () => ({}), () => ({ visibleWidth: () => 0 })]) {
    const late = bashResolver({ metrics: value });
    setMode('own');
    assert.equal(late.resolver('bash', () => HOST_SELF), HOST_SELF, 'the host\'s own row keeps the row');
  }
  // A seam that throws while resolving is the same as none.
  const throwing = bashResolver({ metrics: () => {
    throw new Error('no TUI package');
  } });
  assert.equal(throwing.resolver('bash', () => HOST_SELF), HOST_SELF);
  assert.doesNotThrow(() => throwing.resolver('bash', () => undefined));
});

test('a hostile or absent host hook is `registered: false`, never a throw', () => {
  const none = createBashCardResolver({ metrics, theme: plainTheme });
  assert.equal(none.registered, false, 'no hook is an older host: nothing of ours is drawn');
  assert.doesNotThrow(() => none.resolver('bash', () => undefined));

  const hostile = createBashCardResolver({
    metrics,
    registerToolRenderer: () => {
      throw new Error('no such hook');
    },
  });
  assert.equal(hostile.registered, false);
  assert.doesNotThrow(() => hostile.resolver('bash', () => HOST_SELF));
});

test('the extension\'s one-line registration tolerates a host without the hook', () => {
  const withoutHook = registerBashCard({});
  assert.deepEqual(withoutHook, { registered: false, resolver: undefined }, 'a host without registerToolRenderer keeps its own bash drawing');
  assert.doesNotThrow(() => registerBashCard({}, { metrics: () => metrics }));
  assert.equal(registerBashCard({}, { metrics: () => metrics }).registered, false);

  const hooks = [];
  const host = { registerToolRenderer: (resolver) => hooks.push(resolver) };
  const wired = registerBashCard(host, { metrics: () => metrics });
  assert.equal(wired.registered, true);
  assert.deepEqual(hooks, [wired.resolver]);

  // A throw from the hook itself is still a card that draws nothing, never a broken session.
  const throwingHost = {
    registerToolRenderer: () => {
      throw new Error('hook exploded');
    },
  };
  assert.doesNotThrow(() => registerBashCard(throwingHost, { metrics: () => metrics }));
  assert.equal(registerBashCard(throwingHost, { metrics: () => metrics }).registered, false);
});

// ---- composition with the CodeGraph card is the load order, and nothing else ----
//
// A mode that says "our cards" must not silently hand one command back to the host,
// so this card draws EVERY bash call while the mode is `own` — including a
// `codegraph …` command, which wears the classifier's `codegraph` identity. The
// richer CodeGraph card still owns its own commands because the extension registers
// it FIRST: its resolver then receives ours as `next()`, sees `renderShell: 'self'`
// and claims the row itself, so our slots are never asked. These cases state both
// halves of that truth in the one order the extension uses.

/** Our resolver with its two slots counted, so a case can state that neither was asked. */
function countedResolver(resolver) {
  const asked = [];
  const counted = (toolName, next) => {
    const renderers = resolver(toolName, next);
    if (renderers === undefined) return renderers;
    return {
      ...renderers,
      renderCall: (...args) => {
        asked.push('renderCall');
        return renderers.renderCall(...args);
      },
      renderResult: (...args) => {
        asked.push('renderResult');
        return renderers.renderResult(...args);
      },
    };
  };
  return { asked, resolver: counted };
}

test('with the CodeGraph card registered first, a codegraph command is the CodeGraph card and our slots are never asked', () => {
  const ours = countedResolver(bashResolver().resolver);
  const slot = chain(codegraphResolver(), ours.resolver, HOST_SELF);
  assert.equal(slot.renderShell, 'self', 'the row is a self-framed card');

  // One program, one card: the CodeGraph identity, with the command it ran as the
  // detail, so an invocation whose operation cannot be read still names itself.
  const codegraphCall = callText(slot, { command: 'cd /tmp/ws && codegraph explore -- auth login' });
  assert.match(codegraphCall, /codegraph · cd \/tmp\/ws && codegraph explore/, 'a codegraph command keeps the CodeGraph card');
  assert.doesNotMatch(codegraphCall, /⌕ exploring/, 'it is never this card\'s exploring identity');
  assert.deepEqual(ours.asked, [], 'the CodeGraph card owns the call row outright');

  // The CodeGraph body is the CLI's own output, not a bash card's preview of it.
  const codegraphResult = resultText(slot, { command: 'codegraph init' }, textResult('┌  Initializing CodeGraph\n└  Done'), { expanded: true, isPartial: false });
  assert.match(codegraphResult, /Initializing CodeGraph/, 'the CodeGraph body is the CLI output');
  assert.match(codegraphResult, /Done/);
  assert.deepEqual(ours.asked, [], 'and it owns the result row too');

  // Every other bash call in the same chain is this card's.
  const ownCall = callText(slot, { command: 'pnpm test' });
  assert.match(ownCall, /✓ checking/, 'every other bash call wears the activity card');
  assert.doesNotMatch(ownCall, /codegraph ·/, 'and not the CodeGraph heading');
  assert.deepEqual(ours.asked, ['renderCall'], 'the question reached our call slot only for the row this card owns');
});

test('with only our resolver registered, a codegraph command is OUR card, wearing the codegraph identity', () => {
  // No `codegraph` CLI means nothing of CodeGraph is registered at all (invariant 19),
  // so a mode that says "our cards" has to draw this command itself instead of
  // letting the host's plain row take it.
  const slot = bashResolver().resolver('bash', () => HOST_SELF);
  const identity = SHELL_ACTIVITY_IDENTITY.codegraph;
  const rows = slot.renderCall({ command: 'codegraph init' }, taggedTheme, { isPartial: false }).render(60);
  const heading = rows.map(stripAnsi).join('\n');

  assert.equal(rows.length, 1, 'a settled call is one heading');
  assert.ok(heading.includes(`${identity.glyph} codegraph`), `the heading is the classifier's codegraph identity in "${heading}"`);
  assert.ok(rows[0].includes(`<${identity.titleRole}>${identity.glyph} codegraph</${identity.titleRole}>`), `the label is painted in ${identity.titleRole}`);
  assert.ok(heading.includes('init'), 'the command itself is the heading detail');
  assert.doesNotMatch(heading, /host bash call/, 'the host\'s row was not used');

  // The input after the program is the detail, an argument after the subcommand included.
  const argued = slot.renderCall({ command: 'codegraph status .' }, taggedTheme, { isPartial: false }).render(60).map(stripAnsi).join('\n');
  assert.ok(argued.includes(`${identity.glyph} codegraph`), `the same identity for a subcommand with an argument in "${argued}"`);
  assert.ok(argued.includes('status .'), 'the subcommand and its argument are the detail');
  assert.doesNotMatch(argued, /\$ bash/, 'the row never reads as the generic bash card');

  // And its output is this card's body, not the host's result row.
  const body = slot.renderResult(textResult('┌  Initializing CodeGraph\n└  Done'), { expanded: true, isPartial: false }, plainTheme, { args: { command: 'codegraph init' } }).render(60).map(stripAnsi).join('\n');
  assert.match(body, /Initializing CodeGraph/);
  assert.match(body, /Done/, 'the command\'s own output is the body');
  assert.doesNotMatch(body, /host bash result/, 'the host\'s result row was not used');
});

test('with the mode `default` a codegraph command stays the host\'s own row', () => {
  const cards = bashResolver();
  setMode('default');
  const slot = cards.resolver('bash', () => HOST_SELF);
  assert.equal(slot, HOST_SELF, 'the toggle hands every bash row back, this one included');
  assert.equal(callText(slot, { command: 'codegraph init' }), 'host bash call');
});

test('in the mode `own`, every bash call is this card\'s when it is the only resolver', () => {
  // The rule that matters most: a mode that says "our cards" never hands a bash call
  // to the host. The classifier's own family list is iterated, so a family added
  // there cannot silently fall back either.
  const slot = bashResolver().resolver('bash', () => HOST_SELF);
  const samples = {
    destructive: 'rm -rf build',
    checking: 'pnpm test',
    formatting: 'prettier --write src/a.ts',
    preparing: 'pnpm install',
    publishing: 'git push origin feat/one',
    versioning: 'git commit -m "a message"',
    codegraph: 'codegraph init',
    exploring: 'git status',
  };
  const drawCall = (command) => slot.renderCall({ command }, plainTheme, { isPartial: false }).render(60).map(stripAnsi).join('\n');
  const drawResult = (command) => slot.renderResult(textResult('done'), { isPartial: false }, plainTheme, { args: { command } }).render(60).map(stripAnsi).join('\n');
  for (const activity of SHELL_ACTIVITIES) {
    const sample = samples[activity];
    assert.notEqual(sample, undefined, `this case carries a command for ${activity}`);
    const drawn = drawCall(sample);
    assert.notEqual(drawn, 'host bash call', `${activity} is this card's`);
    const mark = SHELL_ACTIVITY_IDENTITY[activity].glyph.trimEnd();
    assert.ok(drawn.includes(`${mark} `), `${activity} leads with its mark in "${drawn}"`);
    assert.ok(drawn.includes(activity), `${activity} names its word in "${drawn}"`);
    assert.doesNotMatch(drawResult(sample), /host bash result/, `${activity}'s result is this card's body`);
  }

  // And the command nothing names: the generic `$ bash`, still never the host's row.
  const unnamed = drawCall('./scripts/deploy.sh');
  assert.notEqual(unnamed, 'host bash call');
  assert.match(unnamed, /\$ bash/);
  assert.match(unnamed, /\.\/scripts\/deploy\.sh/);
  assert.doesNotMatch(drawResult('./scripts/deploy.sh'), /host bash result/);
});

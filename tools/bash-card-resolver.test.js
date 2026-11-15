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

// ---- L5: composition with the CodeGraph card, in both load orders ----

test('a codegraph command keeps the CodeGraph card in either load order, and every other bash call is ours', () => {
  const ours = bashResolver().resolver;
  const codegraph = codegraphResolver();
  const bases = { 'ours-first': chain(ours, codegraph, HOST_SELF), 'codegraph-first': chain(codegraph, ours, HOST_SELF) };

  for (const [order, slot] of Object.entries(bases)) {
    assert.equal(slot.renderShell, 'self', `${order}: the row is a self-framed card`);
    // One program, one card: the CodeGraph identity and its the operation as the detail.
    const codegraphCall = callText(slot, { command: 'cd /tmp/ws && codegraph explore -- auth login' });
    assert.match(codegraphCall, /codegraph · explore auth login/, `${order}: a codegraph command keeps the CodeGraph card`);
    assert.doesNotMatch(codegraphCall, /⌕ exploring/, `${order}: it is never this card's exploring identity`);
    // A CodeGraph command through the other resolver is the same card in either order.
    const ownCall = callText(slot, { command: 'pnpm test' });
    assert.match(ownCall, /✓ checking/, `${order}: every other bash call wears the activity card`);
    assert.doesNotMatch(ownCall, /codegraph ·/, `${order}: and not the CodeGraph heading`);
  }

  // The two orders draw the SAME CodeGraph heading for one command, and the same own heading.
  assert.equal(
    stripAnsi(callText(bases['ours-first'], { command: 'codegraph query alpha' })),
    stripAnsi(callText(bases['codegraph-first'], { command: 'codegraph query alpha' })),
    'the CodeGraph card is the same row whichever resolver runs first',
  );
  assert.equal(
    stripAnsi(callText(bases['ours-first'], { command: 'git status' })),
    stripAnsi(callText(bases['codegraph-first'], { command: 'git status' })),
    'and so is this card',
  );
});

test('in either order a codegraph command keeps its full output, and the other bash call its own body', () => {
  const ours = bashResolver().resolver;
  const codegraph = codegraphResolver();
  for (const [order, slot] of Object.entries({
    'ours-first': chain(ours, codegraph, HOST_SELF),
    'codegraph-first': chain(codegraph, ours, HOST_SELF),
  })) {
    const forCodegraph = resultText(slot, { command: 'codegraph init' }, textResult('┌  Initializing CodeGraph\n└  Done'), { expanded: true, isPartial: false });
    assert.match(forCodegraph, /Done/, `${order}: the CodeGraph body is the CLI output`);
    const forOwn = resultText(slot, { command: 'pnpm test' }, textResult('RUN  v2.0.0\n ✓ a.test.js'), { expanded: true, isPartial: false });
    assert.match(forOwn, /✓ a\.test\.js/, `${order}: this card's body is the command's output`);
  }
});

test('with the mode `default` a chained resolver still leaves a codegraph command to the CodeGraph card', () => {
  const ours = bashResolver().resolver;
  const codegraph = codegraphResolver();
  setMode('default');
  const slot = chain(codegraph, ours, HOST_SELF);
  // CodeGraph is not the toggled card: its own command keeps it, while every other
  // bash call is the host's again.
  assert.match(callText(slot, { command: 'codegraph query alpha' }), /codegraph · query alpha/);
  assert.equal(callText(slot, { command: 'pnpm test' }), 'host bash call');
});

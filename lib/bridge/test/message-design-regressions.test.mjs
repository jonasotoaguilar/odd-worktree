import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerRows, snapshotProviders } from '../src/bus.ts';
import { installCardStyleTransform } from '../src/card-style-wiring.ts';
import { adoptCustomMessages as adopt } from '../src/message-design-adoption.ts';
import { installMessageDesignRows } from '../src/message-design-rows.ts';
import { messageDesignRenderer } from '../src/message-design-wiring.ts';
import { getMessageDesignFailures, getMessageDesignSelectionReads, registerMessageDesign, setMessageDesignSelection } from '../src/message-designs.ts';
import { collectStatus, formatStatus } from '../src/status.ts';

// Pi stores the result from rebuild(), not a renderer invocation per render().
// Keep this stateful distinction so regressions also fail outside an installed Pi.
function message(customType, customRenderer) {
  const child = {
    message: { customType, content: 'Keep the full body.' }, customRenderer,
    invalidations: 0, component: undefined,
    rebuild() { this.component = this.customRenderer?.(this.message, { expanded: false, outputPad: 3 }, {}); },
    invalidate() { this.invalidations++; this.rebuild(); },
    render(width) { return this.component?.render(width) ?? ['Pi box: ' + this.message.content]; },
  };
  child.rebuild();
  return child;
}
const frame = child => ({ children: [child] });
const register = (customType, apply) => registerMessageDesign({ customType, id: `regression.${customType}`, label: 'card', apply });
const select = customType => setMessageDesignSelection(customType, `regression.${customType}`);
const host = () => ({ render: () => ['host'] });

test.beforeEach(() => { process.env.GENTLE_PI_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'gsb-message-regressions-')); });

test('S1/S4: the bridge owns its provider id, so no plugin can take the line off the menu', () => {
  const provider = { id: 'bridge.message-designs', category: 'Cards', rows: () => [] };
  const disarm = installMessageDesignRows();
  try {
    assert.throws(() => registerRows(provider), /belongs to the bridge's own line/);
    assert.equal(snapshotProviders().includes(provider), false, 'nothing stored');
    const drop = register('provider-collision', () => []);
    try {
      assert.ok(
        snapshotProviders().some((candidate) => candidate.id === 'bridge.message-designs'),
        "the bridge's own line is what answers that id",
      );
    } finally {
      drop();
    }
  } finally {
    disarm();
  }
});

test('S4: no live message design means the conversation adds no message inspection or store reads', () => {
  let inspections = 0;
  const child = message('unclaimed', host), original = child.message, renderer = child.customRenderer;
  Object.defineProperty(child, 'message', { get() { inspections++; return original; } });
  const chat = { children: [child], render: width => child.render(width) };
  installCardStyleTransform({ children: [{ children: [null, null, chat] }] });
  const reads = getMessageDesignSelectionReads();
  assert.deepEqual(chat.render(24), ['host']);
  assert.deepEqual(chat.render(24), ['host']);
  assert.deepEqual([inspections, child.invalidations, getMessageDesignSelectionReads() - reads], [0, 0, 0]);
  assert.equal(child.customRenderer, renderer);
});

test('S2: an own-the-box design failure restores the full fallback body and records once', () => {
  // Real Pi keeps the message's OWN default box on the component (`CustomMessageComponent.box`,
  // built in its constructor), and that box is what a failed design falls back to: the same bytes
  // the user would have seen without a design, at the same width, never a re-drawing of them. The
  // stand-in below carries such a box; a component with no box at all falls back to the message's
  // plain body (label + content), which is the last resort and never an empty frame.
  const child = message('failed-panel');
  // A row that fits: Pi's own box wraps its content, so the fallback never has to measure it.
  child.box = { render: (width) => [`Pi box(${width})`] };
  const before = child.box.render(24);
  const drop = register('failed-panel', () => { throw Error('cannot draw panel'); });
  try {
    select('failed-panel'); adopt(frame(child));
    // The frame that fails shows the box the message already had; the failed design is then not
    // retried, so Pi takes its OWN default path and the box it populates is what every later frame
    // shows. Nothing is drawn twice for the same failure.
    assert.deepEqual(child.render(24), before);
    assert.deepEqual(child.render(24), [`Pi box: ${child.message.content}`]);
    assert.deepEqual(getMessageDesignFailures().filter(f => f.customType === 'failed-panel').map(f => f.message), ['cannot draw panel']);
  } finally { drop(); }
});

test('S2: with no box to ask, a failed design still leaves the message body on screen', () => {
  const child = message('no-box');
  const drop = register('no-box', () => { throw Error('cannot draw panel'); });
  try {
    select('no-box'); adopt(frame(child));
    const rows = child.render(24);
    assert.ok(rows.length > 0, 'never an empty frame');
    assert.ok(rows.some((row) => String(row).includes('no-box')), 'the type is still named');
    assert.ok(rows.some((row) => String(row).includes('Keep the full body.')), 'and the body');
  } finally { drop(); }
});

test('S4: disposing the only active design restores the original box and removes render-time store reads', () => {
  const child = message('disposed-panel'), before = child.render(24);
  const drop = register('disposed-panel', () => ['panel']);
  try {
    select('disposed-panel'); adopt(frame(child)); assert.deepEqual(child.render(24), ['panel']);
  } finally { drop(); }
  adopt(frame(child));
  const reads = getMessageDesignSelectionReads(), after = child.render(24);
  assert.deepEqual([after, getMessageDesignSelectionReads() - reads], [before, 0]);
});

test('S3: host renderer receiver and mouse handler survive wrapping', () => {
  let clicked = 0;
  const child = message('clickable', function () { return { render: () => [this.message.customType], handleMouse() { clicked++; } }; });
  const before = child.render(24);
  const drop = register('clickable', rows => [...rows, 'design']);
  try {
    adopt(frame(child)); assert.deepEqual(child.render(24), before);
    select('clickable'); adopt(frame(child));
    assert.deepEqual(child.render(24), [...before, 'design']);
    child.component.handleMouse?.({}); assert.equal(clicked, 1);
  } finally { drop(); }
});

test('S3: refusing an adoption marker does not replace or repeatedly wrap the renderer', () => {
  const child = message('sealed', host), renderer = child.customRenderer;
  Object.seal(child);
  const drop = register('sealed', rows => [...rows, 'design']);
  try {
    assert.equal(adopt(frame(child)).failed, 1);
    const first = child.customRenderer;
    assert.equal(adopt(frame(child)).failed, 1);
    assert.deepEqual([first === renderer, child.customRenderer === first, child.invalidations], [true, true, 0]);
  } finally { drop(); }
});

test('S3: a still-component renderer does not rebuild on returning to default', () => {
  const child = message('fixed-shape', host);
  const drop = register('fixed-shape', rows => [...rows, 'design']);
  try {
    select('fixed-shape'); adopt(frame(child)); assert.deepEqual(child.render(24), ['host', 'design']);
    setMessageDesignSelection('fixed-shape', 'native'); adopt(frame(child)); adopt(frame(child));
    assert.deepEqual([child.render(24), child.invalidations], [['host'], 1]);
  } finally { drop(); }
});

test('S3: sparse or malformed returned arrays fall back to the host rows rather than throw', () => {
  let result;
  const drop = register('bad-rows', () => result);
  try {
    select('bad-rows');
    const component = messageDesignRenderer('bad-rows', host)({}, {});
    for (const bad of [Array(1), ["x", , "y"], Object.assign(['x'], { every: undefined })]) {
      result = bad;
      assert.doesNotThrow(() => component.render(24), 'a plugin value never throws into the frame');
      // A sparse array is refused: reading by index finds its holes. A dense array whose own `every`
      // was replaced is accepted — its positions ARE rows, nothing calls that member, and only the
      // positions are copied into the frame.
      const sparse = bad.length !== Object.keys(bad).filter((key) => key !== 'every').length;
      assert.deepEqual(component.render(24), sparse ? ['host'] : ['x']);
    }
  } finally { drop(); }
});

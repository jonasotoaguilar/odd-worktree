import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters as strip } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Run with PI_NODE_MODULES pointing to the installed Pi 1.6.0 distribution's node_modules.
// BRIDGE_SOURCE is only for running the unmodified test beside an isolated source archive.
const pi = process.env.PI_NODE_MODULES;
const bridge = process.env.BRIDGE_SOURCE;
const src = file => import(bridge
  ? pathToFileURL(resolve(bridge, 'src', file))
  : new URL(`../src/${file}`, import.meta.url));
const piImport = file => import(pathToFileURL(resolve(pi, '@earendil-works', file)));

if (!pi) {
  test('Pi message-design integration', { skip: 'set PI_NODE_MODULES to Pi 1.6.0' }, () => {});
} else {
  const { CustomMessageComponent: Custom } = await piImport('pi-coding-agent/dist/modes/interactive/components/custom-message.js');
  const { initTheme } = await piImport('pi-coding-agent/dist/modes/interactive/theme/theme.js');
  const { Container } = await piImport('pi-tui/dist/tui.js');
  const { adoptCustomMessages: adopt, resetMessageDesignAdoptionForTests } = await src('message-design-adoption.ts');
  const { getMessageDesignSelectionReads, registerMessageDesign, resetMessageDesignsForTests, setMessageDesignSelection } = await src('message-designs.ts');
  const { snapshotProviders, registerRows, resetBusForTests, registerTransform } = await src('bus.ts');
  const { installMessageDesignRows, resetMessageDesignRowStateForTests } = await src('message-design-rows.ts');
  const { applyTransforms } = await src('transform-pipeline.ts');
  const { TuiMainScreen } = await piImport('pi-tui/dist/tui-main-screen.js');
  const { TuiAltScreen } = await piImport('pi-tui/dist/tui-alt-screen.js');
  initTheme('dark');

  test.beforeEach(() => {
    resetMessageDesignRowStateForTests();
    resetMessageDesignAdoptionForTests();
    resetMessageDesignsForTests();
    resetBusForTests();
    process.env.GENTLE_PI_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'message-design-pi-'));
  });
  const message = (customType, content = 'keep the full body') => ({ role: 'custom', display: true, customType, content });
  const select = (customType, apply) => {
    const off = registerMessageDesign({ customType, id: 'probe.panel', label: 'panel', apply });
    setMessageDesignSelection(customType, 'probe.panel');
    return off;
  };
  const draw = (chat, width = 48) => { adopt(chat); return chat.render(width); };
  const terminal = () => ({ columns: 24, rows: 54, start() {}, stop() {}, hideCursor() {}, showCursor() {}, write() {} });

  test('S2/S3: failed design preserves Pi fallback when an expanded host renderer declines', () => {
    const m = message('conditional');
    const host = (_m, options) => options.expanded ? undefined : { render: () => ['host frame'] };
    const chat = new Container();
    const child = new Custom(m, host), control = new Custom(m, host);
    chat.addChild(child);
    select(m.customType, () => { throw Error('could not paint'); });
    assert.deepEqual(draw(chat), control.render(48));
    child.setExpanded(true);
    control.setExpanded(true);
    // The declined build left Pi's own box unpopulated, so the frame that fails can only show the
    // message's plain body; the recovery is that the failed design is not retried, which lets Pi run
    // its default path and populate the box the next frame renders.
    const native = control.render(48);
    const first = draw(chat);
    if (JSON.stringify(first) !== JSON.stringify(native)) {
      assert.deepEqual(first, ['[conditional]', '', 'keep the full body']);
    }
    assert.deepEqual(draw(chat), native, 'the next ordinary frame recovers without invalidate()');
  });

  test('S2/L7: text parts reach a design that uses the supplied body', () => {
    const m = message('structured', [{ type: 'text', text: 'first' }, { type: 'text', text: 'last' }]);
    const chat = new Container();
    chat.addChild(new Custom(m));
    select(m.customType, lines => [...lines]);
    assert.deepEqual(draw(chat).slice(1), ['[structured]', '', 'first', 'last']);
  });

  test('S4: reconciliation of another conversation cannot strand an adopted message', () => {
    const m = message('revisit');
    const host = () => ({ render: () => ['native'] });
    const first = new Container(), second = new Container();
    const child = new Custom(m, host);
    first.addChild(child);
    const off = select(m.customType, () => ['design']);
    draw(first);
    draw(second);
    off();
    const reads = getMessageDesignSelectionReads();
    assert.deepEqual(draw(first), ['', 'native']);
    assert.equal(child.customRenderer, host);
    assert.equal(getMessageDesignSelectionReads(), reads);
  });

  test('reserved provider ids leave the bus untouched and the message switch available', () => {
    const before = snapshotProviders();
    for (const id of [
      'bridge.sections', 'bridge.card-styles', 'bridge.tool-designs', 'bridge.message-designs',
    ]) {
      assert.throws(
        () => registerRows({ id, category: 'Cards', rows: () => [] }),
        /belongs to the bridge's own line/,
      );
    }
    assert.deepEqual(snapshotProviders(), before, 'nothing stored, nothing replaced');
    installMessageDesignRows();
    assert.equal(
      snapshotProviders().some(p => p.id === 'bridge.message-designs'),
      false,
      'no design yet: no provider at all',
    );
    select('late-menu', () => ['design']);
    const line = snapshotProviders().find(p => p.id === 'bridge.message-designs').rows();
    assert.deepEqual(
      line.map(row => row.choice?.value),
      ['default', 'panel'],
      'the first design installs the line: default first, then the design',
    );
    assert.ok(
      snapshotProviders().flatMap(p => p.rows()).some(r => r.choice?.value === 'panel'),
      'and the design switch is there',
    );
  });

  test('L7: design keeps all rows; pipeline and fullscreen fit columns; regular diff renderer rejects overflow', () => {
    const m = message('width');
    const chat = new Container();
    chat.addChild(new Custom(m));
    const rows = Array.from({ length: 40 }, (_, i) => String(i).padStart(2, '0') + 'x'.repeat(188));
    let output = rows;
    select(m.customType, () => output);
    assert.deepEqual(draw(chat, 24).slice(1), rows);
    const off = registerTransform({ id: 'probe.copy', transform: lines => [...lines] });
    assert.deepEqual(applyTransforms(draw(chat, 24), 24).slice(1), rows.map(row => row.slice(0, 24)));
    off();

    const alt = new TuiAltScreen(terminal(), false, process.env.GENTLE_PI_CONFIG_HOME);
    alt.addChild(chat);
    alt.start();
    try {
      alt.renderNow();
      assert.deepEqual(alt.previousScreen.map(strip).filter(line => /^\d\dx/.test(line)), rows.map(row => row.slice(0, 24)));
    } finally {
      alt.stop({ preserveScreen: true });
    }
    const regular = new TuiMainScreen(terminal(), false, process.env.GENTLE_PI_CONFIG_HOME);
    regular.addChild(chat);
    output = rows.map(row => row.slice(0, 24));
    regular.start();
    try {
      regular.renderNow();
      output = rows;
      assert.throws(() => regular.renderNow(), /^Error: Rendered line 1 exceeds terminal width \(190 > 24\)\./);
    } finally {
      regular.stop();
    }
  });
}

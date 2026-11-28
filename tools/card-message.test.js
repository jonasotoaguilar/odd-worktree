'use strict';
// T1/S1 (card-message): the one `Card message` Off/On line on the shell API's `Cards` page, the
// document it keeps and the reader both cards and the identity prompt ask. It is pure over the
// injected shell API and over the published object the gate reads, so nothing here loads the
// extension.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const cardMessage = require('../lib/card-message.js');

const SHELL_SLOT = Symbol.for('odd-worktree/shell-api/v1');
const STORE = 'odd-worktree';

// A shell API whose `createStore` keeps one in-memory document per plugin id, like the real one:
// `get` and `set` merged per key, and the repaint the row asks for counted.
function fakeShellApi(initial = {}) {
  const documents = new Map(Object.entries(initial));
  const writes = [];
  const repaints = [];
  const createStore = (id) => ({
    get: (key, fallback) => {
      const document = documents.get(id);
      return document !== undefined && Object.hasOwn(document, key) ? document[key] : fallback;
    },
    set: (key, value) => {
      documents.set(id, { ...(documents.get(id) ?? {}), [key]: value });
      writes.push([id, key, value]);
    },
  });
  return {
    api: { schema: 'odd-worktree/shell-api', version: 1, createStore, requestRepaint: () => repaints.push(repaints.length + 1) },
    documents,
    writes,
    repaints,
  };
}

const storedOff = { [STORE]: { 'card-message': { schema: 1, on: false } } };

describe('the Card message row', () => {
  const rowsOf = (shellApi) => cardMessage.cardMessageRowsProvider({ api: shellApi.api }).rows({});

  test('one Off/On line named exactly `Card message`, on the `Cards` page', () => {
    const provider = cardMessage.cardMessageRowsProvider({ api: fakeShellApi().api });
    assert.equal(provider.category, 'Cards');
    assert.equal(typeof provider.id, 'string');
    const rows = provider.rows({});
    assert.deepEqual(rows.map((row) => [row.choice.setting, row.choice.value]), [
      ['Card message', 'Off'],
      ['Card message', 'On'],
    ]);
    for (const row of rows) {
      assert.equal(row.category, 'Cards');
      assert.equal(row.choice.setting, 'Card message', 'the row is the setting');
      assert.equal(row.label(), 'Card message', 'and the label is the setting');
      assert.equal(typeof row.action, 'function');
    }
  });

  test('a stored `on: false` reads Off; nothing stored, and every malformed document, reads On', () => {
    assert.deepEqual(rowsOf(fakeShellApi()).map((row) => row.choice.current()), [false, true], 'On by default');
    assert.deepEqual(rowsOf(fakeShellApi(storedOff)).map((row) => row.choice.current()), [true, false]);
    for (const bad of [null, 42, 'off', [], {}, { on: 'no' }, { on: null }, { schema: 2 }]) {
      const shellApi = fakeShellApi({ [STORE]: { 'card-message': bad } });
      assert.deepEqual(rowsOf(shellApi).map((row) => row.choice.current()), [false, true], JSON.stringify(bad));
    }
  });

  test('Enter persists the value and asks for exactly one repaint', async () => {
    const shellApi = fakeShellApi();
    const rows = rowsOf(shellApi);
    await rows[0].action();
    assert.deepEqual(shellApi.documents.get(STORE)['card-message'], { schema: 1, on: false });
    assert.equal(shellApi.repaints.length, 1, 'the transcript already drawn repaints');
    assert.equal(rows[0].choice.current(), true, 'the same page reads the new value');

    await rows[1].action();
    assert.deepEqual(shellApi.documents.get(STORE)['card-message'], { schema: 1, on: true });
    assert.equal(shellApi.repaints.length, 2);
  });

  test('choosing the value it already has writes nothing and repaints nothing', async () => {
    const shellApi = fakeShellApi();
    await rowsOf(shellApi)[1].action();
    assert.deepEqual(shellApi.writes, []);
    assert.deepEqual(shellApi.repaints, []);
  });

  test('a store that cannot write never repaints and never throws', async () => {
    const api = { createStore: () => ({ get: (_k, fallback) => fallback, set: () => { throw new Error('disk'); } }), requestRepaint: () => { throw new Error('ui gone'); } };
    const rows = cardMessage.cardMessageRowsProvider({ api }).rows({});
    await assert.doesNotReject(async () => rows[0].action());
    await assert.doesNotReject(async () => rows[1].action());
  });
});

describe('the gate both cards ask', () => {
  const publish = (api) => {
    globalThis[SHELL_SLOT] = api;
  };
  beforeEach(() => {
    delete globalThis[SHELL_SLOT];
  });
  afterEach(() => {
    delete globalThis[SHELL_SLOT];
  });

  test('On while nothing is stored, Off once the document says so', () => {
    const shellApi = fakeShellApi();
    publish(shellApi.api);
    assert.equal(cardMessage.cardMessageOn(), true);
    publish(fakeShellApi(storedOff).api);
    assert.equal(cardMessage.cardMessageOn(), false);
  });

  test('no usable shell API published answers false and never throws', () => {
    for (const api of [undefined, null, 42, 'api', {}, { schema: 'other/api', version: 1, createStore: () => ({ get: () => undefined, set: () => {} }) }, { schema: 'odd-worktree/shell-api', version: 2 }]) {
      publish(api);
      assert.equal(cardMessage.cardMessageOn(), false, JSON.stringify(api));
    }
    assert.equal(cardMessage.cardMessageOn(), false, 'nothing published at all');
  });

  test('a store that throws answers false, never a throw', () => {
    publish({ schema: 'odd-worktree/shell-api', version: 1, createStore: () => { throw new Error('disk'); } });
    assert.equal(cardMessage.cardMessageOn(), false);
    publish({ schema: 'odd-worktree/shell-api', version: 1, createStore: () => ({ get: () => { throw new Error('disk'); }, set: () => {} }) });
    assert.equal(cardMessage.cardMessageOn(), false);
  });
});

'use strict';
// native-bridge: the host the vendored bridge factory receives defers `/bridge-status`
// until every extension is loaded, so a standalone bridge that is still installed
// never ends up sharing the command name with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bridgeHost, STATUS_COMMAND } = require('../lib/bridge-host.js');

function fakePi({ owned = [] } = {}) {
  const registered = [];
  const handlers = [];
  const pi = {
    events: { marker: 'bus' },
    registerCommand: (name, definition) => registered.push({ name, definition }),
    on: (event, handler) => handlers.push({ event, handler }),
    getCommands: () => [...owned, ...registered].map((entry) => ({ name: entry.name || entry })),
  };
  const startSession = () => handlers.filter((entry) => entry.event === 'session_start').forEach((entry) => entry.handler({}, {}));
  return { pi, registered, handlers, startSession };
}

const definition = { description: 'status', handler: () => {} };

test('the status command is not registered at load, only at the first session_start', () => {
  const host = fakePi();
  bridgeHost(host.pi).registerCommand(STATUS_COMMAND, definition);
  assert.deepEqual(host.registered, []);
  host.startSession();
  assert.equal(host.registered.length, 1);
  assert.equal(host.registered[0].name, 'bridge-status');
  assert.equal(host.registered[0].definition, definition);
});

test('it registers once however many sessions start', () => {
  const host = fakePi();
  bridgeHost(host.pi).registerCommand(STATUS_COMMAND, definition);
  host.startSession();
  host.startSession();
  host.startSession();
  assert.equal(host.registered.length, 1);
});

test('another copy that already owns the name keeps it: nothing is registered twice', () => {
  const host = fakePi({ owned: ['bridge-status'] });
  bridgeHost(host.pi).registerCommand(STATUS_COMMAND, definition);
  host.startSession();
  assert.deepEqual(host.registered, []);
});

test('every other command goes straight to the real host', () => {
  const host = fakePi();
  bridgeHost(host.pi).registerCommand('something-else', definition);
  assert.deepEqual(host.registered.map((entry) => entry.name), ['something-else']);
  assert.equal(host.handlers.length, 0);
});

test('the rest of the host is the real one: events, on and getCommands are unchanged', () => {
  const host = fakePi({ owned: ['warp'] });
  const view = bridgeHost(host.pi);
  assert.equal(view.events, host.pi.events);
  view.on('session_shutdown', () => {});
  assert.equal(host.handlers.at(-1).event, 'session_shutdown');
  assert.deepEqual(view.getCommands().map((command) => command.name), ['warp']);
});

test('a host that cannot list its commands still gets the command, and a refusing host throws nothing', () => {
  const noList = fakePi();
  delete noList.pi.getCommands;
  bridgeHost(noList.pi).registerCommand(STATUS_COMMAND, definition);
  noList.startSession();
  assert.equal(noList.registered.length, 1);

  const refusing = fakePi();
  refusing.pi.registerCommand = () => {
    throw new Error('refused');
  };
  bridgeHost(refusing.pi).registerCommand(STATUS_COMMAND, definition);
  assert.doesNotThrow(() => refusing.startSession());
});

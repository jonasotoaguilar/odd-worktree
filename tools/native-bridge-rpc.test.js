'use strict';
// native-bridge: the real-host check. It drives a real `pi --mode rpc` with ONLY this package
// loaded, so it proves what the fixture-stubbed suite cannot: the vendored bridge publishes
// its slot, arms, and a third party can extend it. It needs the host binary and a type-stripping
// Node, so it is opt-in: NATIVE_BRIDGE_PI="$(command -v pi)" node --test tools/native-bridge-rpc.test.js
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const pi = process.env.NATIVE_BRIDGE_PI;
const entry = resolve(__dirname, '../extensions/odd-worktree-tools.ts');
const slot = 'Symbol.for("gentle-shell-bridge/api/v1")';
const get = { type: 'get_commands', id: '1' };

function rpc(t, before, after, commands) {
  const dir = mkdtempSync(join(tmpdir(), 'odd-native-rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  const ad = join(dir, 'agent');
  for (const path of [home, tmp, ad]) mkdirSync(path);
  const probe = join(dir, 'probe.ts');
  writeFileSync(probe, before || after);
  const flags = before ? ['-e', probe, '-e', entry] : ['-e', entry, '-e', probe];
  const result = spawnSync('bash', [
    '-c', 'set -o pipefail; (cat; sleep 6) | timeout 25 "$@"', 'rpc',
    pi, '--agent-dir', ad, '--no-session', '-ne', '-ns', '-np', ...flags, '--mode', 'rpc',
  ], {
    cwd: dir, encoding: 'utf8', timeout: 28000,
    input: commands.map((x) => JSON.stringify(x) + '\n').join(''),
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, NO_UPDATE_NOTIFIER: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}

test('only this package: the slot is published, the bridge arms and a third party extends it', { skip: !pi }, (t) => {
  const records = rpc(t, null, `
    export default function (pi) {
      pi.registerCommand("gentle:customize", { handler() {} });
      pi.on("session_start", () => {
        const api = globalThis[${slot}];
        if (api?.schema !== "gentle-shell-bridge/api" || api.version !== 1) throw Error("missing bridge v1");
        api.registerRows({ id: "probe.rows", category: "Probe", rows: () => [] });
      });
    }`, [get, { type: 'prompt', message: '/bridge-status', id: '2' }]);
  const names = records.find((x) => x.id === '1').data.commands.map((c) => c.name);
  for (const name of ['warp', 'odd', 'files', 'identity', 'bridge-status']) {
    assert.equal(names.filter((n) => n === name).length, 1, name);
  }
  assert.equal(records.find((x) => x.id === '2').data.disposition, 'handled');
  const report = records.find((x) => x.message && x.message.startsWith('gentle-shell-bridge status\n'));
  assert.match(report.message, /odd-worktree\.tools \(Tools\)/);
  assert.match(report.message, /odd-worktree\.alert\.peak \(Alert\)/);
  assert.match(report.message, /odd-worktree\.odd-rail "ODD"/);
  assert.match(report.message, /probe\.rows \(Probe\)/);
});

test('an incompatible object on the slot leaves this package\'s surface unregistered', { skip: !pi }, (t) => {
  const records = rpc(t, `
    globalThis[${slot}] = { schema: "other-bridge/api", version: 2 };
    export default function () {}
  `, null, [get]);
  const names = records.find((x) => x.id === '1').data.commands.map((c) => c.name);
  for (const name of ['warp', 'odd', 'files', 'identity', 'issues', 'prs']) {
    assert.equal(names.includes(name), false, `/${name} is not registered`);
  }
});

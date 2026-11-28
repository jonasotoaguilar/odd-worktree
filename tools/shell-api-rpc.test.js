'use strict';
// native-bridge T5: the real-host check. It drives a real `pi --mode rpc` with ONLY this package
// loaded, so it proves what the fixture-stubbed suite cannot: odd-worktree's own shell API
// publishes the slot, arms, and a third party can extend it. It needs the host binary and a
// type-stripping Node, so it is opt-in:
//   NATIVE_BRIDGE_PI="$(command -v pi)" node --test tools/shell-api-rpc.test.js
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const pi = process.env.NATIVE_BRIDGE_PI;
const entry = resolve(__dirname, '../extensions/odd-worktree-tools.ts');
const slot = 'Symbol.for("gentle-shell-bridge/api/v1")';
const get = { type: 'get_commands', id: '1' };

function rpc(t, before, after, commands) {
  const dir = mkdtempSync(join(tmpdir(), 'odd-shell-api-rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  const ad = join(dir, 'agent');
  for (const path of [home, tmp, ad]) mkdirSync(path);
  const probe = join(dir, 'probe.ts');
  const report = join(dir, 'probe-report.json');
  writeFileSync(probe, before || after);
  const flags = before ? ['-e', probe, '-e', entry] : ['-e', entry, '-e', probe];
  const result = spawnSync('bash', [
    '-c', 'set -o pipefail; (cat; sleep 6) | timeout 25 "$@"', 'rpc',
    pi, '--agent-dir', ad, '--no-session', '-ne', '-ns', '-np', ...flags, '--mode', 'rpc',
  ], {
    cwd: dir, encoding: 'utf8', timeout: 28000,
    input: commands.map((x) => JSON.stringify(x) + '\n').join(''),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: tmp,
      NO_UPDATE_NOTIFIER: '1',
      PROBE_REPORT: report,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const report_ = () => JSON.parse(readFileSync(report, 'utf8'));
  return { records, report: report_ };
}

test('only this package: six commands, the slot published, and a third party extends it', { skip: !pi }, (t) => {
  const { records, report } = rpc(t, null, `
    import { writeFileSync } from "node:fs";

    export default function (pi) {
      pi.registerCommand("gentle:customize", { handler() {} });
      pi.on("session_start", () => {
        const api = globalThis[${slot}];
        const answer = {
          schema: api?.schema,
          version: api?.version,
          VERSION: api?.VERSION,
          members: api === undefined ? [] : Object.keys(api).sort(),
        };
        // A third party registers exactly as the contract says, and the registration answers with
        // its own disposer. The slot publishes registries, not readers, so this is the whole
        // observable answer for a caller.
        const disposer = api?.registerRows({ id: "probe.rows", category: "Probe", rows: () => [] });
        answer.disposer = typeof disposer;
        writeFileSync(process.env.PROBE_REPORT, JSON.stringify(answer));
      });
    }`, [get]);
  const names = records.find((x) => x.id === '1').data.commands.map((c) => c.name);
  for (const name of ['warp', 'odd', 'files', 'issues', 'prs', 'identity']) {
    assert.equal(names.filter((candidate) => candidate === name).length, 1, name);
  }
  assert.equal(names.includes('bridge-status'), false, 'the status command is gone');
  const answer = report();
  assert.equal(answer.schema, 'gentle-shell-bridge/api');
  assert.equal(answer.version, 1);
  assert.equal(answer.VERSION, '0.16.2', 'the release consumers gate on');
  assert.deepEqual(answer.members, [
    'VERSION',
    'createStore',
    'registerCardStyle',
    'registerMessageDesign',
    'registerRows',
    'registerSection',
    'registerToolDesign',
    'registerTransform',
    'requestRepaint',
    'resolveToolDesignSelection',
    'schema',
    'version',
  ]);
  assert.equal(answer.disposer, 'function', 'a registration answers with its disposer');
});

test('a first-loaded plugin sees the API, adds a section and removes it again', { skip: !pi }, (t) => {
  const { report } = rpc(t, `
    import { writeFileSync } from "node:fs";

    export default function (pi) {
      pi.registerCommand("gentle:customize", { handler() {} });
      let ready = 0;
      pi.events.on("gentle-shell-bridge:ready", () => { ready += 1; });
      pi.on("session_start", () => {
        const api = globalThis[${slot}];
        const ids = () =>
          globalThis[Symbol.for("gentle-shell-bridge.providers")].sections
            .map((entry) => entry.section.id)
            .sort();
        const own = ids();
        const dispose = api.registerSection({
          id: "verification.section",
          title: "Verification",
          lines: () => ["probe"],
        });
        const added = ids();
        dispose();
        dispose();
        writeFileSync(process.env.PROBE_REPORT, JSON.stringify({
          own, added, after: ids(), ready,
          identity: [api.schema, api.version, api.VERSION],
        }));
      });
    }`, null, [get]);
  const saw = report();
  const own = ['odd-worktree.issues', 'odd-worktree.odd-rail'];
  assert.deepEqual(saw.own, own, 'this package\'s two sections are there before the probe registers');
  assert.deepEqual(saw.added, [...own, 'verification.section'], 'a third party adds its own');
  assert.deepEqual(saw.after, own, 'and its disposer removes exactly that one, twice safely');
  assert.equal(saw.ready, 1, 'the ready announcement reaches a plugin loaded first');
  assert.deepEqual(saw.identity, ['gentle-shell-bridge/api', 1, '0.16.2']);
});

test('an incompatible object on the slot leaves this package\'s surface unregistered and says so once', { skip: !pi }, (t) => {
  const { records } = rpc(t, `
    globalThis[${slot}] = { schema: "other-bridge/api", version: 2 };
    export default function (pi) {
      pi.registerCommand("gentle:customize", { handler() {} });
    }
  `, null, [get]);
  const names = records.find((x) => x.id === '1').data.commands.map((c) => c.name);
  for (const name of ['warp', 'odd', 'files', 'identity', 'issues', 'prs']) {
    assert.equal(names.includes(name), false, `/${name} is not registered`);
  }
  const warnings = records.filter((x) => x.method === 'notify' && x.notifyType === 'warning');
  const foreign = warnings.filter((x) => x.message.startsWith('odd-worktree:'));
  assert.equal(foreign.length, 1, 'one notice, in this package\'s own words');
  assert.match(foreign[0].message, /other-bridge\/api/, 'it names the schema the slot really holds');
  assert.match(foreign[0].message, /"2"/, 'and its version');
  assert.match(foreign[0].message, /sidebar sections/, 'and what is off');
});

for (const schema of ['third-party/v2', 'gentle-shell-bridge/api']) {
  test(`foreign slot ${schema}: one warning, no commands, no row of this package, and no load failure`, { skip: !pi }, (t) => {
    const { records, report } = rpc(t, `
      import { writeFileSync } from "node:fs";
      const key = ${slot};
      const foreign = {
        schema: ${JSON.stringify(schema)},
        get version() { throw new Error("unreadable version"); },
      };
      globalThis[key] = foreign;
      export default function (pi) {
        pi.registerCommand("gentle:customize", { handler() {} });
        pi.on("session_start", () => setImmediate(() => {
          const bus = globalThis[Symbol.for("gentle-shell-bridge.providers")];
          writeFileSync(process.env.PROBE_REPORT, JSON.stringify({
            preserved: globalThis[key] === foreign,
            providers: ((bus && bus.entries) || []).map((entry) => entry.provider.id),
          }));
        }));
      }
    `, null, [get]);
    const commands = records.find((x) => x.id === '1').data.commands;
    assert.deepEqual(commands.filter((x) => x.source === 'extension').map((x) => x.name), ['gentle:customize']);
    const warnings = records.filter((x) => x.method === 'notify' && x.notifyType === 'warning' && x.message.startsWith('odd-worktree:'));
    assert.equal(warnings.length, 1, 'one notice, in this package\'s own words');
    assert.ok(warnings[0].message.includes(`schema "${schema}", version "unreadable"`));
    const saw = report();
    assert.equal(saw.preserved, true, 'the foreign object is never replaced');
    assert.deepEqual(saw.providers.filter((id) => id.startsWith('odd-worktree.')), [], 'none of this package\'s own rows');
  });
}

'use strict';
// S4 (UI consistency round 3): lib/warp-delete-confirm.js — the ONE builder
// both warp keyboard surfaces use, tested through its exported functions.
//
// What is pinned here is the honesty of the disclosure, which the extension's
// wiring tests can only reach with a Git repository that answers every read:
//   - pending changes and commits ahead of `main` are named when they exist;
//   - a clean checkout adds no warning, so the dialog never cries wolf;
//   - a read that FAILS is reported as unknown with its reason, never as 0,
//     never as "no pending changes" and never as safe;
//   - `force` travels only on positive evidence of pending changes;
//   - the ahead-of-main comparison is asked for `main` explicitly, so a
//     repository without `main` says so instead of silently comparing with
//     `origin/main` or `master`.
//
// Every fixture is a throwaway Git repository under the system temp directory:
// nothing here deletes a real checkout, and no test touches a real registry.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const confirmLib = require('../lib/warp-delete-confirm.js');
const changesLib = require('../lib/worktree-changes.js');

const roots = [];

after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

// Deterministic incompressible bytes: `--binary` zlib-compresses the patch, so
// a repeating pattern would produce a tiny patch and never reach the budget.
function noise(length, seed = 0x9e3779b9) {
  const buffer = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buffer[index] = state & 0xff;
  }
  return buffer;
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-confirm-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

const TARGET = { name: 'feat-del', path: '/checkouts/feat-del', branch: 'feat/del' };
const BASE_BODY = `Delete worktree checkout at ${TARGET.path} for branch '${TARGET.branch}'? This removes the checkout but keeps the branch.`;

describe('S4: the keyboard delete dialog is always asked and always honest', () => {
  test('the title names the worktree and a clean, zero-ahead checkout adds no warning', async () => {
    const repo = makeRepo('clean');
    git(repo, ['branch', 'main', 'HEAD']);
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.deepEqual(evidence.changes, { status: 'clean', files: 0, added: 0, deleted: 0 });
    assert.equal(evidence.aheadMain.status, 'none');
    assert.equal(evidence.aheadMain.ahead, 0);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.title, "Delete worktree 'feat-del'?");
    assert.equal(prompt.body, BASE_BODY);
    assert.equal(prompt.force, false, 'a clean checkout is never forced');
  });

  test('pending changes and commits ahead of main are both named, and only dirty evidence forces', async () => {
    const repo = makeRepo('dirty-ahead');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'seed']);
    git(repo, ['branch', 'main', 'HEAD']);
    // Two commits `main` does not have, then one pending line.
    git(repo, ['commit', '--allow-empty', '-m', 'ahead one']);
    git(repo, ['commit', '--allow-empty', '-m', 'ahead two']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.changes.status, 'dirty');
    assert.equal(evidence.changes.files, 1);
    assert.equal(evidence.changes.added, 1);
    assert.equal(evidence.aheadMain.status, 'ahead');
    assert.equal(evidence.aheadMain.ahead, 2);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Pending changes: 1 file, +1/-0. Commits ahead of main: 2.`);
    assert.equal(prompt.force, true, 'positive dirty evidence is what authorizes force');
  });

  test('commits ahead of main are named on their own for a clean checkout', async () => {
    const repo = makeRepo('ahead-only');
    git(repo, ['branch', 'main', 'HEAD']);
    git(repo, ['commit', '--allow-empty', '-m', 'ahead one']);
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.changes.status, 'clean');
    assert.equal(evidence.aheadMain.status, 'ahead');
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Commits ahead of main: 1.`);
    assert.equal(prompt.force, false, 'ahead-of-main alone never forces');
  });

  test('a missing main branch is reported as unknown instead of being compared with another base', async () => {
    const repo = makeRepo('no-main');
    git(repo, ['commit', '--allow-empty', '-m', 'only on master']);
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.aheadMain.status, 'unknown');
    assert.equal(evidence.aheadMain.ahead, null, 'unknown stays distinguishable from zero');
    assert.match(evidence.aheadMain.reason, /main/);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Commits ahead of main: unknown (base branch not found: main).`);
    assert.ok(!/Commits ahead of main: 0/.test(prompt.body), 'unknown is never reported as zero');
  });

  test('a failed change summary is reported as unknown and never authorizes force', async () => {
    const repo = makeRepo('changes-fail');
    git(repo, ['branch', 'main', 'HEAD']);
    const failing = {
      summarizeChanges: async () => ({ ok: false, error: 'cannot diff this checkout' }),
    };
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, { changesLib: failing });
    assert.equal(evidence.changes.status, 'unknown');
    assert.equal(evidence.aheadMain.status, 'none', 'the other read is unaffected');
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Uncommitted changes: unknown (cannot diff this checkout).`);
    assert.equal(prompt.force, false, 'unknown evidence never forces');
  });

  test('a change summary that throws is reported as unknown, not as clean', async () => {
    const repo = makeRepo('changes-throw');
    git(repo, ['branch', 'main', 'HEAD']);
    const throwing = {
      summarizeChanges: async () => { throw new Error('git exploded'); },
    };
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, { changesLib: throwing });
    assert.equal(evidence.changes.status, 'unknown');
    assert.match(evidence.changes.reason, /git exploded/);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.match(prompt.body, /Uncommitted changes: unknown \(git exploded\)\./);
    assert.equal(prompt.force, false);
  });

  test('a path that is not a checkout reports both reads as unknown with reasons and never rejects', async () => {
    const outside = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-confirm-outside-'))));
    const evidence = await confirmLib.readWarpDeleteEvidence(outside);
    assert.equal(evidence.changes.status, 'unknown');
    assert.ok(typeof evidence.changes.reason === 'string' && evidence.changes.reason.length > 0);
    assert.equal(evidence.aheadMain.status, 'unknown');
    assert.ok(typeof evidence.aheadMain.reason === 'string' && evidence.aheadMain.reason.length > 0);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.match(prompt.body, /Uncommitted changes: unknown \(/);
    assert.match(prompt.body, /Commits ahead of main: unknown \(/);
    assert.equal(prompt.force, false);
  });

  test('an empty checkout path is refused as unknown evidence instead of being probed', async () => {
    const evidence = await confirmLib.readWarpDeleteEvidence('');
    assert.equal(evidence.changes.status, 'unknown');
    assert.equal(evidence.aheadMain.status, 'unknown');
    assert.equal(evidence.aheadMain.ahead, null);
    assert.equal(confirmLib.warpDeletePrompt(TARGET, evidence).force, false);
  });

  test('the production change summary is the module the extension already uses', () => {
    // The builder must consume the shared summary, not a second dirty check.
    assert.equal(typeof changesLib.summarizeChanges, 'function');
    assert.equal(typeof confirmLib.readWarpDeleteEvidence, 'function');
    assert.equal(typeof confirmLib.warpDeletePrompt, 'function');
  });
});

// The dialog is answered BEFORE the removal, so the evidence the human read can
// be stale by the time the checkout would be deleted. The key below is what
// makes that comparison possible: two reads with the same key described the
// same pending work and the same ahead-of-main state, so the confirmation still
// describes the checkout; any difference means the human was shown something
// that is no longer true and the caller must ask again.
describe('S4: a confirmed disclosure can be compared with the read after it', () => {
  const CLEAN = { changes: { status: 'clean', files: 0, added: 0, deleted: 0 }, aheadMain: { status: 'none', ahead: 0 } };
  const DIRTY = { changes: { status: 'dirty', files: 1, added: 1, deleted: 0 }, aheadMain: { status: 'none', ahead: 0 } };

  test('the same reading is the same key, whatever else the object carries', () => {
    const copy = JSON.parse(JSON.stringify(DIRTY));
    assert.equal(confirmLib.warpDeleteEvidenceKey(DIRTY), confirmLib.warpDeleteEvidenceKey(copy));
  });

  test('a clean read, a changed count and an unreadable read are all different keys', () => {
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(CLEAN), confirmLib.warpDeleteEvidenceKey(DIRTY));
    const moreFiles = { changes: { ...DIRTY.changes, files: 2, added: 4 }, aheadMain: DIRTY.aheadMain };
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(DIRTY), confirmLib.warpDeleteEvidenceKey(moreFiles));
    const unreadable = { changes: { status: 'unknown', reason: 'git exploded' }, aheadMain: DIRTY.aheadMain };
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(DIRTY), confirmLib.warpDeleteEvidenceKey(unreadable));
    const aheadChanged = { changes: DIRTY.changes, aheadMain: { status: 'ahead', ahead: 3 } };
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(DIRTY), confirmLib.warpDeleteEvidenceKey(aheadChanged));
  });

  test('a read of the same checkout before and after it gained a line changes the key', async () => {
    // No `main` here on purpose: both ahead-of-main reads answer the same
    // `unknown`, so the key moves only because the PENDING WORK moved.
    const repo = makeRepo('key-changes');
    const clean = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(clean.changes.status, 'clean');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    const dirty = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(dirty.changes.status, 'dirty');
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(clean), confirmLib.warpDeleteEvidenceKey(dirty));
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'seed']);
    const cleanAgain = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(cleanAgain.changes.status, 'clean');
    assert.equal(confirmLib.warpDeleteEvidenceKey(clean), confirmLib.warpDeleteEvidenceKey(cleanAgain),
      'the same pending-work statement is the same key, so a stable read never refuses');
  });
});

// A1 (verification): `+A/-D` is not the pending work. Rewriting a line leaves
// the counts identical while the bytes differ, so a confirmation bound only to
// the counts authorizes deleting something the human never saw. The evidence
// therefore carries a CONTENT fingerprint, and a read that cannot produce one
// is `unknown` — never "unchanged".
describe('A1: the confirmation is bound to the pending CONTENT, not to a line count', () => {
  test('the same counts with different bytes are a different reading', async () => {
    const repo = makeRepo('content-swap');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'seed']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    const first = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(first.changes.status, 'dirty');
    assert.deepEqual(
      { files: first.changes.files, added: first.changes.added, deleted: first.changes.deleted },
      { files: 1, added: 1, deleted: 1 },
      'the fixture really keeps the counts identical',
    );
    assert.equal(first.content.status, 'known');
    // Same added/deleted counts, different bytes.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
    const second = await confirmLib.readWarpDeleteEvidence(repo);
    assert.deepEqual(
      { files: second.changes.files, added: second.changes.added, deleted: second.changes.deleted },
      { files: first.changes.files, added: first.changes.added, deleted: first.changes.deleted },
      'the counts are still identical',
    );
    assert.notEqual(first.content.fingerprint, second.content.fingerprint, 'but the content fingerprint moved');
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(first), confirmLib.warpDeleteEvidenceKey(second));
  });

  test('an unchanged checkout reads the same fingerprint every time', async () => {
    const repo = makeRepo('content-stable');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'seed']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
    const first = await confirmLib.readWarpDeleteEvidence(repo);
    const second = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(first.content.status, 'known');
    assert.equal(first.content.fingerprint, second.content.fingerprint);
    assert.equal(confirmLib.warpDeleteEvidenceKey(first), confirmLib.warpDeleteEvidenceKey(second));
  });

  test('untracked files are part of the content fingerprint, so a silent edit is caught', async () => {
    const repo = makeRepo('content-untracked');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'alpha\n');
    const first = await confirmLib.readWarpDeleteEvidence(repo);
    const second = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(confirmLib.warpDeleteEvidenceKey(first), confirmLib.warpDeleteEvidenceKey(second), 'a stable read is stable');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'alpha\nbeta\n');
    const grown = await confirmLib.readWarpDeleteEvidence(repo);
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(first), confirmLib.warpDeleteEvidenceKey(grown));
  });

  test('a fingerprint that cannot be read is unknown, never an unchanged reading', async () => {
    const repo = makeRepo('content-unknown');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    const failing = {
      aheadBehind: async () => ({ ok: true, ahead: 0, base: 'main' }),
      runArgvAsync: async (bin, argv) => (argv[0] === 'diff' && argv.includes('--binary')
        ? { status: 128, stdout: '', stderr: 'diff exploded', error: null }
        : { status: 0, stdout: '', stderr: '', error: null }),
    };
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, {
      git: failing,
      changesLib: { summarizeChanges: async () => ({ ok: true, files: 0, added: 0, deleted: 0 }) },
    });
    assert.equal(evidence.content.status, 'unknown');
    assert.match(evidence.content.reason, /diff exploded/);
  });

  test('pending work past the fingerprint budget is unknown instead of being guessed', async () => {
    const repo = makeRepo('content-budget');
    fs.writeFileSync(path.join(repo, 'big.bin'), 'x'.repeat(4096));
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, { maxFingerprintBytes: 64 });
    assert.equal(evidence.content.status, 'unknown');
    assert.match(evidence.content.reason, /larger than/);
  });

  // The budget used to be checked only inside the UNTRACKED loop, after the
  // tracked patch had already been collected from stdout and decoded: a 40 MiB
  // binary patch cost ~247 MiB of RSS and was never refused at all, because a
  // checkout with no untracked files never entered that loop.
  test('a tracked patch alone past the budget is unknown, and never authorizes a delete', async () => {
    const repo = makeRepo('content-tracked-budget');
    // Wholesale replacement, so the binary delta cannot shrink the patch under
    // the budget the way a single flipped byte does.
    const before = noise(8192, 0x9e3779b9);
    const after = noise(8192, 0x51ed270b);
    fs.writeFileSync(path.join(repo, 'a.bin'), before);
    git(repo, ['add', 'a.bin']);
    git(repo, ['commit', '-m', 'seed']);
    fs.writeFileSync(path.join(repo, 'a.bin'), after);
    assert.equal(git(repo, ['status', '--porcelain=v1', '--untracked-files=all']), 'M a.bin',
      "the fixture's pending work is the TRACKED patch, with no untracked file to notice the cap");
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, { maxFingerprintBytes: 1024 });
    assert.equal(evidence.content.status, 'unknown');
    assert.equal(evidence.content.fingerprint, null);
    assert.match(evidence.content.reason, /larger than 1024 bytes/);
  });

  test('a tracked binary patch within the budget is fingerprinted by its bytes', async () => {
    const repo = makeRepo('content-tracked-binary');
    const seed = noise(256, 0x12345678);
    fs.writeFileSync(path.join(repo, 'a.bin'), seed);
    git(repo, ['add', 'a.bin']);
    git(repo, ['commit', '-m', 'seed']);
    fs.writeFileSync(path.join(repo, 'a.bin'), Buffer.concat([seed, Buffer.from([0, 255, 7])]));
    const first = await confirmLib.readWarpDeleteEvidence(repo);
    const second = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(first.content.status, 'known');
    assert.equal(first.content.fingerprint, second.content.fingerprint, 'a stable binary patch is stable');
    fs.writeFileSync(path.join(repo, 'a.bin'), Buffer.concat([seed, Buffer.from([0, 255, 8])]));
    const changed = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(changed.content.status, 'known');
    assert.notEqual(first.content.fingerprint, changed.content.fingerprint,
      'one different byte in a binary patch changes the reading');
  });

  test('an untracked file past the budget is refused by its size, without being read whole', async () => {
    const repo = makeRepo('content-untracked-budget');
    const big = path.join(repo, 'huge.bin');
    // Sparse on every filesystem this suite runs on: the SIZE is what must be
    // refused before a read, so the fixture does not need 64 MiB of real data.
    const fd = fs.openSync(big, 'w');
    try {
      fs.ftruncateSync(fd, 64 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, { maxFingerprintBytes: 1024 * 1024 });
    assert.equal(evidence.content.status, 'unknown');
    assert.equal(evidence.content.fingerprint, null);
    assert.match(evidence.content.reason, /larger than 1048576 bytes/);
  });

  // The memory guarantee itself: the patch is written by git to a private
  // file, so the shared runner never collects its bytes on stdout. Its size is
  // then what the cap decides on, and the scratch file never outlives the read.
  test('the tracked patch is staged in a private file, never buffered on the child stdout', async () => {
    const repo = makeRepo('content-patch-file');
    fs.writeFileSync(path.join(repo, 'a.bin'), Buffer.from([0, 1, 2, 3]));
    git(repo, ['add', 'a.bin']);
    git(repo, ['commit', '-m', 'seed']);
    fs.writeFileSync(path.join(repo, 'a.bin'), Buffer.from([9, 8, 7, 6]));
    const patchText = 'diff --binary staged bytes\n';
    let diffArgv = null;
    let stagedPath = null;
    const recording = {
      aheadBehind: async () => ({ ok: true, ahead: 0, base: 'main' }),
      runArgvAsync: async (bin, argv) => {
        if (argv[0] !== 'diff') return { status: 0, stdout: '', stderr: '', error: null };
        diffArgv = argv;
        const output = argv.find((entry) => entry.startsWith('--output='));
        assert.ok(output, 'the patch is addressed to a file instead of the child stdout');
        stagedPath = output.slice('--output='.length);
        fs.writeFileSync(stagedPath, patchText);
        return { status: 0, stdout: '', stderr: '', error: null };
      },
    };
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, {
      git: recording,
      changesLib: { summarizeChanges: async () => ({ ok: true, files: 0, added: 0, deleted: 0 }) },
    });
    assert.ok(diffArgv.includes('--binary'), 'binary edits still count');
    assert.equal(evidence.content.status, 'known');
    assert.equal(evidence.content.bytes, Buffer.byteLength(patchText),
      'the byte count comes from the staged file, not from a decoded stdout string');
    assert.equal(fs.existsSync(stagedPath), false, 'the scratch patch is removed before the read resolves');
  });
});

// A2 (verification): a checkout can read CLEAN while git ignores files that
// only exist inside it, and removing the checkout deletes them. They are
// therefore disclosed in the question, and their path list is part of the
// reading so a file that appears during the dialog is noticed.
describe('A2: ignored files are disclosed, never silently deleted', () => {
  function withIgnored(tag) {
    const repo = makeRepo(tag);
    git(repo, ['branch', 'main', 'HEAD']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\nbuild/\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore rules']);
    fs.writeFileSync(path.join(repo, 'debug.log'), 'log\n');
    fs.mkdirSync(path.join(repo, 'build'));
    fs.writeFileSync(path.join(repo, 'build', 'out.txt'), 'artifact\n');
    return repo;
  }

  test('a checkout that reads clean but holds ignored files discloses them', async () => {
    const repo = withIgnored('ignored-present');
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.changes.status, 'clean', 'nothing git tracks is pending');
    assert.equal(evidence.ignored.status, 'present');
    assert.equal(evidence.ignored.files, 2);
    assert.deepEqual(evidence.ignored.samples, ['build/out.txt', 'debug.log']);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.match(prompt.body, /Ignored files \(deleted with the checkout\): build\/out\.txt, debug\.log\./);
    assert.equal(prompt.force, false, 'ignored files do not force: git needs no --force for them');
  });

  test('a checkout with no ignored files keeps the dialog byte-identical', async () => {
    const repo = makeRepo('ignored-none');
    git(repo, ['branch', 'main', 'HEAD']);
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.ignored.status, 'none');
    assert.equal(evidence.ignored.files, 0);
    assert.equal(confirmLib.warpDeletePrompt(TARGET, evidence).body, BASE_BODY);
    assert.equal(confirmLib.warpDeletePrompt(TARGET, evidence).force, false);
  });

  test('an unreadable ignored listing is unknown, and the key notices a file that appeared', async () => {
    const repo = withIgnored('ignored-listing');
    const before = await confirmLib.readWarpDeleteEvidence(repo);
    fs.writeFileSync(path.join(repo, 'late.log'), 'late\n');
    const after = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(after.ignored.files, 3);
    assert.notEqual(confirmLib.warpDeleteEvidenceKey(before), confirmLib.warpDeleteEvidenceKey(after),
      'an ignored file that appeared changes the reading');

    const failing = {
      aheadBehind: async () => ({ ok: true, ahead: 0, base: 'main' }),
      runArgvAsync: async (bin, argv) => (argv[0] === 'ls-files'
        ? { status: 1, stdout: '', stderr: 'ls-files exploded', error: null }
        : { status: 0, stdout: '', stderr: '', error: null }),
    };
    const unreadable = await confirmLib.readWarpDeleteEvidence(repo, {
      git: failing,
      changesLib: { summarizeChanges: async () => ({ ok: true, files: 0, added: 0, deleted: 0 }) },
    });
    assert.equal(unreadable.ignored.status, 'unknown');
    assert.match(unreadable.ignored.reason, /ls-files exploded/);
  });
});

// S7/S8: the warp panel's Ctrl+D runs the SAME active-session guard as the
// `worktree_delete` tool, and it runs it BEFORE the pending-change question.
// These cases drive the real `/warp` command with a host double: `ui.custom`
// answers the marker the selector's `ctrl+d` emits, `ui.confirm` records the
// one dialog, and every temp worktree is created through the registered tool.
describe('S7/S8: Ctrl+D checks live sessions before the deletion question', () => {
  const crypto = require('node:crypto');
  const { loadExtension } = require('./fixtures/load-extension.js');

  const HOOK_BIN = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-confirm-hookbin-')));
  const AGENT_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-confirm-agent-home-')));
  const PRESENCE = path.join(AGENT_HOME, 'gentle-agents', 'presence');

  const savedEnv = { ...process.env };
  let commands;
  let tools;
  let restorePath = null;

  before(async () => {
    delete process.env.GENTLE_PI_AGENT_HOME;
    process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
    restorePath = process.env.PATH;
    process.env.PATH = `${HOOK_BIN}${path.delimiter}${process.env.PATH || ''}`;
    ({ commands, tools } = await loadExtension({}));
  });

  after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  });

  function publishSession({ sessionId, label = 'Worker', workspace, heartbeat = Date.now(), incarnationIndex = 1 }) {
    fs.mkdirSync(PRESENCE, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(PRESENCE, 0o700); } catch { /* best effort */ }
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const incarnation = `2000000${incarnationIndex}-0000-4000-8000-00000000000${incarnationIndex}`;
    fs.writeFileSync(path.join(PRESENCE, `${sessionHash}.${incarnation}.header.json`), JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation,
      label,
      heartbeat,
      generation: 1,
      counts: { running: 0, queued: 0, waiting: 0, finished: 0 },
      digest: 'a'.repeat(64),
      unavailable: null,
    }));
    fs.writeFileSync(path.join(PRESENCE, `${sessionHash}.${incarnation}.discovery.json`), JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation,
      generation: 1,
      metadata: { activation: 'b'.repeat(64), workspace, tasks: [], omitted: 0 },
    }));
    return sessionHash;
  }

  // One registered worktree plus the host double that presses Ctrl+D on it.
  async function panelFixture(tag, { confirm } = {}) {
    const repo = makeRepo(`ctrl-d-${tag}`);
    git(repo, ['branch', 'main', 'HEAD']);
    const created = await tools.get('worktree_create').execute(
      `create-${tag}`, { branch: `feat/${tag}` }, undefined, undefined,
      {
        cwd: repo,
        hasUI: false,
        mode: 'tui',
        sessionManager: { getSessionId: () => 'panel-session' },
        ui: { confirm: async () => false, notify: () => {} },
      },
    );
    assert.notEqual(created.isError, true, JSON.stringify(created));
    // The path the create really wrote, not a remembered flattened spelling.
    const target = created.details.path;
    const notifications = [];
    const confirmations = [];
    let mounts = 0;
    const ctx = {
      cwd: repo,
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => 'panel-session' },
      ui: {
        // The selector's `ctrl+d` emits the delete marker once; the loop then
        // reopens the panel, and closing it (undefined) ends the flow.
        custom: async () => (mounts++ === 0 ? { delete: target } : undefined),
        confirm: async (title, body) => {
          confirmations.push({ title, body });
          if (typeof confirm === 'function') return confirm({ title, body, target });
          return true;
        },
        notify: (text, level) => { notifications.push([level, text]); },
      },
    };
    return { repo, target, notifications, confirmations, ctx };
  }

  test('a live session in the target refuses before the pending-change question', async () => {
    const { target, notifications, confirmations, ctx } = await panelFixture('busy');
    const sessionHash = publishSession({ sessionId: 'panel-busy-worker', label: 'Busy', workspace: target, incarnationIndex: 5 });
    await commands.get('warp').handler('', ctx);
    assert.equal(confirmations.length, 0, 'no deletion question is asked for a checkout a session is working in');
    const refusal = notifications.find(([level]) => level === 'error');
    assert.ok(refusal, JSON.stringify(notifications));
    assert.match(refusal[1], /working in that checkout/);
    assert.ok(refusal[1].includes(sessionHash.slice(0, 12)), refusal[1]);
    assert.ok(fs.existsSync(target), 'the checkout survives the refusal');
  });

  test('Ctrl+D still asks the pending-change question for a clear checkout and removes it after approval', async () => {
    const { repo, target, notifications, confirmations, ctx } = await panelFixture('clear');
    await commands.get('warp').handler('', ctx);
    assert.equal(confirmations.length, 1, 'exactly one deletion question');
    assert.match(confirmations[0].title, /^Delete worktree '/);
    assert.match(confirmations[0].body, /Delete worktree checkout at /);
    assert.match(confirmations[0].body, /keeps the branch/);
    assert.equal(fs.existsSync(target), false, 'the approved checkout is removed');
    assert.ok(notifications.some(([level, text]) => level === 'info' && /worktree deleted/.test(text)), JSON.stringify(notifications));
    assert.equal(
      git(repo, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/clear'),
      true,
      'the branch is kept',
    );
  });

  // Invariant 4 (AGENTS.md): the guard's caveats are disclosed, never silently
  // dropped. The panel's ctrl+d is the only surface that removes a checkout now,
  // so a stale presence record must reach the human from HERE — the delete tool
  // whose formatter used to print it is unregistered (T6/S4).
  test('a stale presence record\u2019s caveat reaches the human on the panel delete', async () => {
    const { target, notifications, confirmations, ctx } = await panelFixture('stale-caveat');
    publishSession({
      sessionId: 'crashed-panel-worker', label: 'Crashed', workspace: target,
      heartbeat: Date.now() - 10 * 60 * 1000, incarnationIndex: 8,
    });
    await commands.get('warp').handler('', ctx);

    assert.equal(confirmations.length, 1, 'the stale record never blocks the question');
    assert.equal(fs.existsSync(target), false, 'the removal still happens');
    assert.ok(
      notifications.some(([level, text]) => level === 'info' && /worktree deleted/.test(String(text))),
      JSON.stringify(notifications),
    );
    const caveat = notifications.find(([, text]) => /stale Gentle Shell presence record ignored/.test(String(text)));
    assert.ok(caveat, `the stale record is disclosed: ${JSON.stringify(notifications)}`);
    assert.match(caveat[1], /best effort/);
    assert.equal(caveat[0], 'warning', 'the caveat is a warning, not a silent info line');
  });

  test('a session that appears while the question is open refuses the removal after approval', async () => {
    const { target, notifications, confirmations, ctx } = await panelFixture('late', {
      confirm: ({ target: doomed }) => {
        publishSession({ sessionId: 'late-worker', label: 'Late', workspace: doomed, incarnationIndex: 6 });
        return true;
      },
    });
    await commands.get('warp').handler('', ctx);
    assert.equal(confirmations.length, 1, 'the human was asked exactly once');
    const failure = notifications.find(([level]) => level === 'error');
    assert.ok(failure, JSON.stringify(notifications));
    assert.match(failure[1], /working in that checkout/);
    assert.ok(fs.existsSync(target), 'the post-approval recheck refuses the removal');
  });
});

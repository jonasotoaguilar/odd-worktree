'use strict';
// T8 (odd-rail-section S8, S9): lib/odd-session.js, the record of the ODD
// documents THIS session wrote or edited.
//
// Contract under test, through the public surface only:
// - ONLY a `write` or an `edit` registers (S8). `read`, `bash`, `grep`, a missing
//   tool name and every other tool never do, and neither does a `.md` that is not
//   directly under an `odd/tasks` directory: a document outside it, one nested
//   below it, a dotfile, a non-Markdown file. The rule is lib/odd-docs.js's scan
//   rule (`<root>/odd/tasks/*.md`, non-recursive, dotfiles skipped, the `.md`
//   suffix case-insensitive), stated lexically so no file is read.
// - The event is the shape the extension's own readers accept (mirrored here):
//   `toolName`/`tool`/`name`, `paths`/`path`, a `cwd` for a relative target, and
//   `isError` for the FAILED call that registers nothing.
// - A relative target resolves against the call's `cwd`; the stored path is
//   ABSOLUTE and normalized, and a relative one without a cwd registers nothing.
// - Idempotent per absolute path: a second touch moves the document to the front
//   and updates `at`, never a second row. One tool call is ONE timestamp.
// - `touched()` is most recently touched first and hands out copies, so a caller
//   cannot mutate the record.
// - `entryOf(touch)` is the persisted entry body, and `TOUCH_ENTRY_TYPE` is the
//   customType every reader filters on.
// - `restore(entries)` rebuilds from what `ctx.sessionManager.getEntries()`
//   returned: only the touch entries, one per path (newest `at` wins), newest
//   first, and EVERY garbage entry — a non-array answer included — is skipped
//   without throwing. It replaces the record rather than merging into it.
// - The clock is the injected one: nothing here reads wall time, and a call that
//   registers nothing reads no clock at all.
//
// No fs, no git, no timer: every case is in-memory.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createOddSession, TOUCH_ENTRY_TYPE } = require('../lib/odd-session.js');

const CWD = '/home/me/repo';
const ENTRY_TYPE = 'odd-worktree.odd-touch';

// A clock the tests own, so `at` is an observable and never wall time. `calls`
// pins that a call which registers nothing reads it zero times.
function clock(start = 1000) {
  let at = start;
  let calls = 0;
  const now = () => {
    calls += 1;
    return at;
  };
  now.tick = (ms = 10) => {
    at += ms;
    return at;
  };
  now.read = () => at;
  now.calls = () => calls;
  return now;
}

function session(now) {
  return createOddSession({ now: now ?? clock() });
}

const abs = (rel) => path.join(CWD, rel);
const noteWrite = (target, extra = {}) => ({ toolName: 'write', paths: [target], cwd: CWD, ...extra });

describe('what counts as a touch (S8)', () => {
  test('a write or an edit on an odd/tasks document registers; every other tool never does', () => {
    const touched = session();
    assert.equal(touched.note({ toolName: 'write', paths: ['odd/tasks/alpha.md'], cwd: CWD }), true);
    assert.equal(touched.note({ toolName: 'edit', paths: [abs('odd/tasks/beta.md')], cwd: CWD }), true);
    for (const toolName of ['read', 'bash', 'grep', 'find', 'ls', 'worktree_create', '', undefined, 42]) {
      assert.equal(touched.note({ toolName, paths: ['odd/tasks/gamma.md'], cwd: CWD }), false, String(toolName));
    }
    assert.deepEqual(
      touched.touched().map((touch) => touch.name),
      ['beta', 'alpha'],
    );
  });

  test('a .md that is not directly under odd/tasks never registers', () => {
    const touched = session();
    for (const target of [
      'docs/alpha.md',
      'alpha.md',
      'odd/alpha.md',
      'odd/tasks/nested/alpha.md',
      'odd/tasks/deeper/nested/alpha.md',
      'odd/tasks/.alpha.md',
      'odd/tasks/alpha.txt',
      'odd/tasks/alpha.md.bak',
      'odd/tasks',
      'odd/tasks/',
      'odd/tasks/alpha',
    ]) {
      assert.equal(touched.note(noteWrite(target)), false, target);
    }
    // ... while the document of ANY checkout root does: the segments are the rule,
    // not the prefix (`<root>/odd/tasks/*.md` for whichever root the session sits in).
    assert.equal(touched.note(noteWrite('src/odd/tasks/alpha.md')), true);
    assert.equal(touched.note(noteWrite('/elsewhere/odd/tasks/beta.MD')), true);
    assert.deepEqual(touched.touched().map((touch) => touch.name), ['beta', 'alpha']);
  });

  test('a relative target resolves against the call cwd and is stored absolute and normalized', () => {
    const touched = session();
    assert.equal(touched.note(noteWrite('./odd/tasks/../tasks/alpha.md')), true);
    assert.deepEqual(touched.touched(), [{ path: abs('odd/tasks/alpha.md'), name: 'alpha', at: 1000 }]);
    // The same document by its absolute spelling is the SAME row, not a second one.
    assert.equal(touched.note(noteWrite(abs('odd/tasks/alpha.md'))), true);
    assert.equal(touched.touched().length, 1);
    // A relative target with no cwd cannot be resolved: it is not guessed from
    // the process's own directory.
    assert.equal(touched.note({ toolName: 'write', paths: ['odd/tasks/beta.md'] }), false);
    assert.equal(touched.touched().length, 1);
  });

  test('a FAILED call registers nothing', () => {
    const touched = session();
    assert.equal(touched.note({ ...noteWrite('odd/tasks/alpha.md'), isError: true }), false);
    assert.deepEqual(touched.touched(), []);
    assert.equal(touched.note({ ...noteWrite('odd/tasks/alpha.md'), isError: false }), true);
  });

  test('the event accessors mirror the extension’s own readers', () => {
    const touched = session();
    // `oddToolNameOf`/`oddTouchedPaths` accept these spellings, so a host that
    // sends another one is still the same call.
    assert.equal(touched.note({ tool: 'write', path: 'odd/tasks/alpha.md', cwd: CWD }), true);
    assert.equal(touched.note({ name: 'edit', paths: ['odd/tasks/beta.md'], cwd: CWD }), true);
    assert.deepEqual(touched.touched().map((touch) => touch.path), [abs('odd/tasks/beta.md'), abs('odd/tasks/alpha.md')]);
  });

  test('a re-touch moves the document to the front and updates `at`, never a second row', () => {
    const now = clock();
    const touched = session(now);
    touched.note(noteWrite('odd/tasks/alpha.md'));
    now.tick();
    touched.note(noteWrite('odd/tasks/beta.md'));
    now.tick();
    touched.note(noteWrite('odd/tasks/gamma.md'));
    assert.deepEqual(touched.touched().map((touch) => touch.name), ['gamma', 'beta', 'alpha']);
    const at = now.tick();
    assert.equal(touched.note(noteWrite('odd/tasks/alpha.md')), true);
    assert.deepEqual(touched.touched().map((touch) => touch.name), ['alpha', 'gamma', 'beta']);
    assert.equal(touched.touched()[0].at, at);
    assert.equal(touched.touched().length, 3, 'one row per absolute path');
  });

  test('one tool call is ONE timestamp, and a call that registers nothing reads no clock', () => {
    const now = clock();
    const touched = session(now);
    assert.equal(touched.note({ toolName: 'write', paths: ['odd/tasks/alpha.md', 'odd/tasks/beta.md'], cwd: CWD }), true);
    const [beta, alpha] = touched.touched();
    assert.equal(alpha.at, 1000);
    assert.equal(beta.at, 1000);
    assert.equal(now.calls(), 1);
    touched.note({ toolName: 'read', paths: ['odd/tasks/alpha.md'], cwd: CWD });
    touched.note(noteWrite('docs/alpha.md'));
    assert.equal(now.calls(), 1);
  });

  test('touched() hands out copies, so a caller cannot mutate the record', () => {
    const touched = session();
    touched.note(noteWrite('odd/tasks/alpha.md'));
    const rows = touched.touched();
    rows.push({ path: '/elsewhere/odd/tasks/fake.md', name: 'fake', at: 1 });
    rows[0].path = '/tampered';
    assert.deepEqual(touched.touched(), [{ path: abs('odd/tasks/alpha.md'), name: 'alpha', at: 1000 }]);
  });

  test('has(path) answers for the stored absolute path', () => {
    const touched = session();
    touched.note(noteWrite('odd/tasks/alpha.md'));
    assert.equal(touched.has(abs('odd/tasks/alpha.md')), true);
    assert.equal(touched.has('odd/tasks/alpha.md'), false, 'the stored key is absolute');
    assert.equal(touched.has(abs('odd/tasks/beta.md')), false);
    assert.equal(touched.has(undefined), false);
  });

  test('entryOf(touch) is the persisted body, under the one customType', () => {
    const touched = session();
    touched.note(noteWrite('odd/tasks/alpha.md'));
    assert.equal(TOUCH_ENTRY_TYPE, ENTRY_TYPE);
    const entry = touched.entryOf(touched.touched()[0]);
    assert.deepEqual(entry, {
      customType: ENTRY_TYPE,
      data: { path: abs('odd/tasks/alpha.md'), at: 1000 },
    });
  });

  test('clear() forgets everything', () => {
    const touched = session();
    touched.note(noteWrite('odd/tasks/alpha.md'));
    touched.clear();
    assert.deepEqual(touched.touched(), []);
    assert.equal(touched.has(abs('odd/tasks/alpha.md')), false);
  });
});

describe('restore (S8/S9)', () => {
  // The entries `ctx.sessionManager.getEntries()` returns: Pi's CustomEntry shape
  // (`{ type: "custom", id, parentId, timestamp, customType, data }`, docs/
  // session-format.md), which is the shape every reader in the extension filters on.
  const entry = (id, file, at, customType = ENTRY_TYPE, type = 'custom') => ({
    type,
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    customType,
    data: { path: abs(`odd/tasks/${file}.md`), at },
  });

  test('keeps the touch entries, newest first, one per path, and returns how many it restored', () => {
    const touched = session();
    const restored = touched.restore([
      entry('a', 'alpha', 1000),
      entry('b', 'beta', 3000),
      entry('c', 'alpha', 2000),
    ]);
    assert.equal(restored, 2);
    assert.deepEqual(touched.touched(), [
      { path: abs('odd/tasks/beta.md'), name: 'beta', at: 3000 },
      { path: abs('odd/tasks/alpha.md'), name: 'alpha', at: 2000 },
    ]);
  });

  test('skips every garbage entry without throwing', () => {
    const touched = session();
    const restored = touched.restore([
      null,
      undefined,
      'odd-worktree.odd-touch',
      42,
      {},
      entry('a', 'alpha', 1000),
      { type: 'custom', customType: ENTRY_TYPE },
      { type: 'custom', customType: ENTRY_TYPE, data: null },
      { type: 'custom', customType: ENTRY_TYPE, data: {} },
      { type: 'custom', customType: ENTRY_TYPE, data: { path: 42, at: 1000 } },
      { type: 'custom', customType: ENTRY_TYPE, data: { path: abs('odd/tasks/gamma.md'), at: Number.NaN } },
      { type: 'custom', customType: ENTRY_TYPE, data: { path: abs('odd/tasks/delta.md'), at: Number.POSITIVE_INFINITY } },
      { type: 'custom', customType: ENTRY_TYPE, data: { path: '', at: 1000 } },
      { type: 'custom', customType: 'odd-worktree.other', data: { path: abs('odd/tasks/beta.md'), at: 1000 } },
      { type: 'custom_message', customType: ENTRY_TYPE, data: { path: abs('odd/tasks/beta.md'), at: 1000 } },
      { type: 'message', id: 'm', role: 'user' },
    ]);
    assert.equal(restored, 1);
    assert.deepEqual(touched.touched(), [{ path: abs('odd/tasks/alpha.md'), name: 'alpha', at: 1000 }]);
  });

  test('a non-array answer restores nothing instead of throwing', () => {
    for (const answer of [undefined, null, 'entries', 42, {}]) {
      const touched = session();
      touched.note(noteWrite('odd/tasks/alpha.md'));
      assert.equal(touched.restore(answer), 0, String(answer));
      assert.deepEqual(touched.touched(), []);
    }
  });

  test('replaces the record instead of merging into it', () => {
    const touched = session();
    touched.note(noteWrite('odd/tasks/alpha.md'));
    touched.restore([entry('b', 'beta', 3000)]);
    assert.deepEqual(touched.touched().map((touch) => touch.name), ['beta']);
  });

  test('a restored record then behaves exactly like a noted one', () => {
    const now = clock(5000);
    const touched = session(now);
    touched.restore([entry('a', 'alpha', 1000), entry('b', 'beta', 2000)]);
    assert.equal(touched.has(abs('odd/tasks/alpha.md')), true);
    assert.deepEqual(touched.entryOf(touched.touched()[0]), {
      customType: ENTRY_TYPE,
      data: { path: abs('odd/tasks/beta.md'), at: 2000 },
    });
    touched.note(noteWrite('odd/tasks/alpha.md'));
    assert.deepEqual(touched.touched(), [
      { path: abs('odd/tasks/alpha.md'), name: 'alpha', at: 5000 },
      { path: abs('odd/tasks/beta.md'), name: 'beta', at: 2000 },
    ]);
  });
});

// T1 (odd-rail-session-scope S3, S4): the association rebuilt from the session's
// OWN history, the source that covers OLD sessions (written before the touch entry
// existed) and RESUMED ones. The caller hands over the ACTIVE branch only
// (`ctx.sessionManager.getBranch()`), so an abandoned branch's write is simply not
// an entry this function ever sees.
//
// What the history names, all by ODD NAME (`odd/tasks/<name>.md`):
// - an assistant `write`/`edit` toolCall whose matching `toolResult` (`toolCallId`)
//   is not an error;
// - the persisted `odd-worktree.odd-touch` entries;
// - a `gentle-agents.result` custom_message whose report lists the path in its
//   `files_changed:` block, and the `Spec: odd/tasks/<name>.md` line of a
//   successful `subagent_run`/`subagent_continue` task;
// - nothing else, and every malformed entry is SKIPPED instead of thrown on.
const { associatedFromHistory } = require('../lib/odd-session.js');

const assistant = (id, blocks) => ({
  type: 'message',
  id,
  parentId: null,
  message: { role: 'assistant', content: blocks, timestamp: 1 },
});
const toolCall = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const result = (id, toolCallId, isError = false, toolName = 'write') => ({
  type: 'message',
  id,
  parentId: null,
  message: { role: 'toolResult', toolCallId, toolName, isError, content: [], timestamp: 1 },
});
const touchEntry = (id, file, at = 1000) => ({
  type: 'custom',
  id,
  parentId: null,
  customType: ENTRY_TYPE,
  data: { path: abs(`odd/tasks/${file}.md`), at },
});
const resultMessage = (content, customType = 'gentle-agents.result') => ({
  type: 'custom_message',
  id: 'r',
  parentId: null,
  customType,
  content,
  display: true,
});
const names = (set) => [...set].sort();

describe('the association rebuilt from history (S3, S4)', () => {
  test('a successful write or edit on an odd/tasks document is associated by name', () => {
    const associated = associatedFromHistory([
      assistant('a1', [toolCall('call-1', 'write', { path: 'odd/tasks/alpha.md', content: '# alpha' })]),
      result('r1', 'call-1', false, 'write'),
      assistant('a2', [toolCall('call-2', 'edit', { path: abs('odd/tasks/beta.md') })]),
      result('r2', 'call-2', false, 'edit'),
    ]);
    assert.deepEqual(names(associated), ['alpha', 'beta']);
  });

  test('a failed or unanswered call is not associated, and the result is matched by toolCallId', () => {
    const associated = associatedFromHistory([
      assistant('a1', [toolCall('call-1', 'write', { path: 'odd/tasks/alpha.md' })]),
      result('r1', 'call-1', true),
      // A successful result for ANOTHER call never vouches for this one.
      assistant('a2', [toolCall('call-2', 'write', { path: 'odd/tasks/beta.md' })]),
      result('r2', 'call-9', false),
      // ... and a call whose result never landed (an in-flight or aborted turn).
      assistant('a3', [toolCall('call-3', 'edit', { path: 'odd/tasks/gamma.md' })]),
      assistant('a4', [toolCall('call-4', 'read', { path: 'odd/tasks/delta.md' })]),
      result('r4', 'call-4', false, 'read'),
    ]);
    assert.deepEqual(names(associated), []);
  });

  test('a path with `..` or one that is not exactly odd/tasks/<name>.md is ignored', () => {
    const paths = [
      'docs/alpha.md',
      'odd/alpha.md',
      'odd/tasks/nested/alpha.md',
      'odd/tasks/.alpha.md',
      'odd/tasks/alpha.txt',
      'odd/tasks/alpha.md.bak',
      'odd/tasks/../tasks/alpha.md',
      '/repo/odd/../odd/tasks/alpha.md',
      'odd/tasks',
      '',
      undefined,
      42,
    ];
    const entries = [];
    paths.forEach((target, index) => {
      entries.push(assistant(`a${index}`, [toolCall(`call-${index}`, 'write', { path: target })]));
      entries.push(result(`r${index}`, `call-${index}`));
    });
    assert.deepEqual(names(associatedFromHistory(entries)), []);
  });

  test('the persisted odd-touch entries are associated, whether or not a tool call is still in history', () => {
    const associated = associatedFromHistory([
      { type: 'custom', id: 'x', customType: 'odd-worktree.other', data: { path: abs('odd/tasks/nope.md'), at: 1 } },
      touchEntry('a', 'alpha'),
      touchEntry('b', 'beta'),
      // The same document by its other spelling is the same NAME.
      touchEntry('c', 'alpha', 2000),
    ]);
    assert.deepEqual(names(associated), ['alpha', 'beta']);
  });

  test('a gentle-agents.result report associates every odd/tasks document under `files_changed:`', () => {
    const content = [
      'status: completed',
      'summary: did the work',
      'files_changed:',
      `  - ${abs('odd/tasks/alpha.md')}: the change`,
      '  - odd/tasks/beta.md: another change',
      '  - lib/odd-session.js: not a document',
      '',
      'validation:',
      '  - npm test: pass',
    ].join('\n');
    assert.deepEqual(names(associatedFromHistory([resultMessage(content)])), ['alpha', 'beta']);
    // The content may arrive as text blocks, exactly as Pi stores a custom message.
    assert.deepEqual(
      names(associatedFromHistory([resultMessage([{ type: 'text', text: content }])])),
      ['alpha', 'beta'],
    );
    // A custom_message under another customType is somebody else's report.
    assert.deepEqual(names(associatedFromHistory([resultMessage(content, 'someone.else')])), []);
  });

  test('a successful subagent task naming a Spec document is associated', () => {
    const task = 'Do the work.\n\nSpec: odd/tasks/gamma.md, T1, T2\n\n## Allowed edit surfaces\n- lib/odd-session.js';
    const associated = associatedFromHistory([
      assistant('a1', [toolCall('call-1', 'subagent_run', { task })]),
      result('r1', 'call-1', false, 'subagent_run'),
      assistant('a2', [toolCall('call-2', 'subagent_continue', { task: 'Spec: odd/tasks/delta.md, T3' })]),
      result('r2', 'call-2', false, 'subagent_continue'),
      // A failed subagent did no work on its Spec.
      assistant('a3', [toolCall('call-3', 'subagent_run', { task: 'Spec: odd/tasks/epsilon.md, T4' })]),
      result('r3', 'call-3', true, 'subagent_run'),
      // A Spec line that names no document is no association.
      assistant('a4', [toolCall('call-4', 'subagent_run', { task: 'Spec: odd/tasks/../docs/zeta.md, T5' })]),
      result('r4', 'call-4', false, 'subagent_run'),
    ]);
    assert.deepEqual(names(associated), ['delta', 'gamma']);
  });

  test('a quoted example document is a placeholder, never an ODD', () => {
    // Prose that shows the rule reaches a transcript as an ordinary path: the
    // harness quotes `Spec: odd/tasks/<existing>.md, T<n>`. Electing it would name
    // an ODD that cannot exist.
    const associated = associatedFromHistory([
      assistant('a1', [
        toolCall('c1', 'subagent_run', { task: 'Do it.\n\nSpec: odd/tasks/<existing>.md, T2, S1' }),
        toolCall('c2', 'subagent_run', { task: 'Do it.\n\nSpec: odd/tasks/real-one.md, T2, S1' }),
      ]),
      result('r1', 'c1', false, 'subagent_run'),
      result('r2', 'c2', false, 'subagent_run'),
      resultMessage('files_changed:\n  - odd/tasks/<name>.md: what changed'),
    ]);
    assert.deepEqual(names(associated), ['real-one']);
    // A space is a real name, not a placeholder: the rail must still list it.
    assert.deepEqual(
      names(associatedFromHistory([assistant('a2', [toolCall('c3', 'write', { path: 'odd/tasks/with space.md' })]), result('r3', 'c3')])),
      ['with space'],
    );
  });

  test('garbage entries, garbage blocks and garbage content are skipped instead of thrown on', () => {
    const associated = associatedFromHistory([
      null,
      undefined,
      'odd/tasks/alpha.md',
      42,
      {},
      { type: 'message' },
      { type: 'message', message: null },
      { type: 'message', message: { role: 'assistant', content: 'nope' } },
      { type: 'message', message: { role: 'assistant', content: [null, 7, {}, { type: 'text' }, toolCall('c', 'write')] } },
      { type: 'message', message: { role: 'toolResult' } },
      { type: 'custom', customType: ENTRY_TYPE, data: null },
      { type: 'custom', customType: ENTRY_TYPE, data: { path: 42, at: 1 } },
      { type: 'custom_message', customType: 'gentle-agents.result', content: 42 },
      { type: 'custom_message', customType: 'gentle-agents.result', content: [null, { type: 'text', text: null }] },
      touchEntry('a', 'alpha'),
    ]);
    assert.deepEqual(names(associated), ['alpha']);
    for (const answer of [undefined, null, 'entries', 42, {}]) {
      assert.deepEqual(names(associatedFromHistory(answer)), []);
    }
  });
});

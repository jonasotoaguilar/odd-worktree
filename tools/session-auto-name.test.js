'use strict';
// The ODD session name: lib/session-auto-name.js, the one module that decides what
// a session is called after it writes an ODD task document.
//
// What is asserted here, through the module's public functions:
// - D2 (label): the session is named after the ODD DOCUMENT ITSELF, never after
//   prose inside it: `odd/tasks/prompt-card-fix.md` names the session `Prompt card
//   fix` — `-` and `_` become spaces, `/` of a nested feature becomes a space, the
//   first letter is capitalized and the rest of the name is left alone.
// - D3 (every write): each `write`/`edit` on an `odd/tasks/*.md` document re-derives
//   the name, so a second ODD written later in the same session renames it again.
// - D4 (never clobber a human): a name the plugin cannot account for is untouched;
//   the plugin writes only an empty name or one it can prove it produced.
// - D5 (resume): the proof survives a process restart because it comes from the
//   ODDs this session already wrote (the persisted `odd-worktree.odd-touch` record
//   hands their names in), not from memory alone; the dashed slugs earlier versions
//   wrote stay adoptable for the same reason.
// - D6 (trigger): only a WRITE renames. Reading a document is context gathering and
//   leaves the name alone, and so does any path that is not `odd/tasks/<name>.md`.
// - D7 (idempotent): the derived name already applied writes nothing.
// - D8 (phase): a `gentle_odd_phase` transition re-applies the session's own label,
//   including after a resume, and invents nothing when the session never wrote one.
//
// Pure: no fs, no git, no clock. The branch is deliberately NOT part of the name any
// more (the user's decision: the session is called `Prompt card fix`, not
// `Prompt card fix @ feat/prompt-card-fix`).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  LABEL_MAX_CHARS,
  ODD_PHASE_TOOL_NAME,
  canAdoptSessionName,
  isPluginSessionName,
  labelFromFeature,
  planPhaseSessionRename,
  planSessionRename,
} = require('../lib/session-auto-name.js');

// A fresh session id per case: the module remembers the last applied label per
// session, and two cases must never share that memory.
let sessionSeq = 0;
function nextSessionId() {
  sessionSeq += 1;
  return `session-${sessionSeq}`;
}

const BRANCH = 'feat/prompt-card-fix';

describe('labelFromFeature: the ODD document names the session', () => {
  test('dashes become spaces and only the first letter is capitalized', () => {
    assert.equal(labelFromFeature('prompt-card-fix'), 'Prompt card fix');
  });

  test('the rest of the name keeps its own case', () => {
    assert.equal(labelFromFeature('alt-i-and-PR-links'), 'Alt i and PR links');
  });

  test('underscores are a word separator too', () => {
    assert.equal(labelFromFeature('rail_cards_fixes'), 'Rail cards fixes');
  });

  test('a nested feature keeps every segment, joined by spaces', () => {
    assert.equal(labelFromFeature('perf/plan'), 'Perf plan');
  });

  test('a name that is not a feature yields no label', () => {
    assert.equal(labelFromFeature(''), null);
    assert.equal(labelFromFeature('---'), null);
    assert.equal(labelFromFeature(undefined), null);
  });

  test('a long name is cut at the last whole word inside the limit', () => {
    const label = labelFromFeature('a-very-long-odd-name-that-goes-past-the-limit-of-the-label');
    assert.ok(label.length <= LABEL_MAX_CHARS, `label ${label} exceeds ${LABEL_MAX_CHARS}`);
    assert.equal(label, 'A very long odd name that goes past the limit');
  });

  test('one word longer than the limit is cut hard, never left empty', () => {
    const label = labelFromFeature('a'.repeat(LABEL_MAX_CHARS + 10));
    assert.equal(label.length, LABEL_MAX_CHARS);
  });
});

describe('planSessionRename: every ODD write renames the session', () => {
  test('the first ODD write names an unnamed session after that document', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: '',
      sessionId: nextSessionId(),
    });
    assert.equal(label, 'Prompt card fix');
  });

  test('a session with no name at all is adopted', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: undefined,
      sessionId: nextSessionId(),
    });
    assert.equal(label, 'Prompt card fix');
  });

  test('writing ANOTHER ODD renames again, to that ODD', () => {
    const sessionId = nextSessionId();
    const first = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: '',
      sessionId,
    });
    assert.equal(first, 'Prompt card fix');
    const second = planSessionRename({
      rels: ['odd/tasks/warp-odd-picker.md'],
      isWrite: true,
      currentName: first,
      sessionId,
    });
    assert.equal(second, 'Warp odd picker');
  });

  test('an EDIT renames exactly like a write', () => {
    const sessionId = nextSessionId();
    planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: 'Something else entirely',
      sessionId,
    });
    const label = planSessionRename({
      rels: ['odd/tasks/prs-panel.md'],
      isWrite: true,
      currentName: '',
      sessionId,
    });
    assert.equal(label, 'Prs panel');
  });

  test('the same label already applied writes nothing', () => {
    const sessionId = nextSessionId();
    const first = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: '',
      sessionId,
    });
    const again = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: first,
      sessionId,
    });
    assert.equal(again, null);
  });

  test('a human name is never overwritten', () => {
    const sessionId = nextSessionId();
    const label = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: 'Mi sesión de investigación',
      sessionId,
    });
    assert.equal(label, null);
  });

  test('a READ renames nothing', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: false,
      currentName: '',
      sessionId: nextSessionId(),
    });
    assert.equal(label, null);
  });

  test('a document outside odd/tasks renames nothing', () => {
    const sessionId = nextSessionId();
    assert.equal(
      planSessionRename({
        rels: ['docs/reference.md', 'odd/tasks/nested/deep/x.txt', 'odd/tasks/'],
        isWrite: true,
        currentName: '',
        sessionId,
      }),
      null,
    );
  });

  test('the title inside the document is not the source of the name', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: '',
      sessionId: nextSessionId(),
      // A caller that still hands a reader in changes nothing: the document's own
      // prose never names the session.
      readDocument: () => '# Una guía completamente distinta\n',
    });
    assert.equal(label, 'Prompt card fix');
  });

  test('the branch is not part of the name', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      branch: BRANCH,
      currentName: '',
      sessionId: nextSessionId(),
    });
    assert.equal(label, 'Prompt card fix');
    assert.ok(!label.includes('@'), 'a branch suffix must not appear');
  });
});

describe('resume: the proof survives a restart', () => {
  // A resumed session has no in-memory memory: the only evidence is the ODDs this
  // session already wrote, handed in from the persisted touch record.
  test('a label that belongs to one of this session ODDs is its own', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/warp-odd-picker.md'],
      isWrite: true,
      currentName: 'Prompt card fix',
      sessionId: nextSessionId(),
      touchedNames: ['prompt-card-fix'],
    });
    assert.equal(label, 'Warp odd picker');
  });

  test('a label belonging to no ODD of this session stays a human name', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/warp-odd-picker.md'],
      isWrite: true,
      currentName: 'Prompt card fix',
      sessionId: nextSessionId(),
      touchedNames: ['unrelated-odd'],
    });
    assert.equal(label, null);
  });

  test('the dashed slugs earlier versions wrote stay adoptable', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/warp-odd-picker.md'],
      isWrite: true,
      currentName: 'prompt-card-fix',
      sessionId: nextSessionId(),
    });
    assert.equal(label, 'Warp odd picker');
  });

  test('a name with a branch suffix from an earlier version stays adoptable', () => {
    const label = planSessionRename({
      rels: ['odd/tasks/warp-odd-picker.md'],
      isWrite: true,
      currentName: `prompt-card-fix @ ${BRANCH}`,
      sessionId: nextSessionId(),
    });
    assert.equal(label, 'Warp odd picker');
  });
});

describe('isPluginSessionName / canAdoptSessionName: the ownership test', () => {
  test('an empty or absent name is adoptable', () => {
    assert.equal(canAdoptSessionName(''), true);
    assert.equal(canAdoptSessionName(undefined), true);
  });

  test('a human name is not', () => {
    assert.equal(isPluginSessionName('Mi sesión de investigación'), false);
    assert.equal(canAdoptSessionName('Mi sesión de investigación', {}), false);
  });

  test('a name it produced for the touched document is its own', () => {
    assert.equal(isPluginSessionName('Prompt card fix', { feature: 'prompt-card-fix' }), true);
  });

  test('a name from its own durable record is its own', () => {
    assert.equal(
      isPluginSessionName('Prompt card fix', { sessionLabels: ['Prompt card fix'] }),
      true,
    );
  });

  test('a non-string name is never adopted', () => {
    assert.equal(canAdoptSessionName(42), false);
  });
});

describe('planPhaseSessionRename: a phase transition re-applies what the session derived', () => {
  test('the phase tool name is the one Pi publishes', () => {
    assert.equal(ODD_PHASE_TOOL_NAME, 'gentle_odd_phase');
  });

  test('it re-applies the label this session last derived from a write', () => {
    const sessionId = nextSessionId();
    const first = planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: '',
      sessionId,
    });
    // Something else set the name in between; the plugin's own label still applies.
    const label = planPhaseSessionRename({ sessionId, currentName: '' });
    assert.equal(label, first);
  });

  test('a session that never wrote an ODD invents nothing', () => {
    assert.equal(planPhaseSessionRename({ sessionId: nextSessionId(), currentName: '' }), null);
  });

  test('after a resume it re-applies the newest ODD of its durable record', () => {
    const label = planPhaseSessionRename({
      sessionId: nextSessionId(),
      currentName: '',
      touchedNames: ['prompt-card-fix', 'warp-odd-picker'],
    });
    assert.equal(label, 'Prompt card fix');
  });

  test('it never overwrites a human name', () => {
    const label = planPhaseSessionRename({
      sessionId: nextSessionId(),
      currentName: 'Mi sesión de investigación',
      touchedNames: ['prompt-card-fix'],
    });
    assert.equal(label, null);
  });

  test('the label already applied writes nothing', () => {
    const sessionId = nextSessionId();
    planSessionRename({
      rels: ['odd/tasks/prompt-card-fix.md'],
      isWrite: true,
      currentName: '',
      sessionId,
    });
    assert.equal(planPhaseSessionRename({ sessionId, currentName: 'Prompt card fix' }), null);
  });
});

'use strict';
// S3/S9 (issues-sidebar): a row seeded from the rail's cache must behave exactly
// like a row a fresh read produced. This pins the three facts that took three
// verify rounds to get right, including the debounce window the branch retains ON
// PURPOSE: rows stay painted while the query is being typed, the count never
// claims a total for a query it did not answer, and the rows are hidden when the
// request starts and replaced by its answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIssuesView } = require('../lib/issues-view.js');

test('S3/S9: seeded and fresh rows share query-bound counts and debounce behavior', async () => {
  const tick = () => new Promise(setImmediate);
  const issue = (number, title) => ({ number, title, state: 'open' });

  for (const seeded of [false, true]) {
    const answers = [];
    const scheduled = [];
    const view = createIssuesView({
      pages: [{
        id: 'mine',
        label: 'My issues',
        issues: seeded ? [issue(21, 'old twenty-one')] : null,
        total: seeded ? 1 : null,
      }],
      loadIssuePage: () => new Promise((resolve) => answers.push(resolve)),
      scheduleQuery: (fn) => { scheduled.push(fn); return fn; },
      cancelSchedule() {},
    });

    if (!seeded) {
      answers[0]({
        ok: true,
        issues: [issue(21, 'old twenty-one')],
        total: 1,
        hasNextPage: false,
      });
      await tick();
    }

    const frame = () => view.render(200).join('\n');
    assert.match(frame(), /old twenty-one/);

    view.handleInput('t');
    view.handleInput('l');
    assert.match(frame(), /old twenty-one/);
    assert.match(frame(), /My issues \(–\)/);

    for (const key of 'abel:bug') view.handleInput(key);
    assert.match(frame(), /My issues \(–\)/);

    scheduled.at(-1)();
    await tick();
    assert.doesNotMatch(frame(), /old twenty-one/);
    assert.match(frame(), /My issues \(–\)/);

    answers.at(-1)({
      ok: true,
      issues: [issue(99, 'filtered ninety-nine')],
      total: 1,
      hasNextPage: false,
    });
    await tick();
    assert.match(frame(), /filtered ninety-nine/);
    assert.match(frame(), /My issues \(1\)/);
  }
});

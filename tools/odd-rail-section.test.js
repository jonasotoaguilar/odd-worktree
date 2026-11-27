'use strict';
// T3 (odd-rail-section S1, S2, S5, S6): lib/odd-rail-section.js, the pure module.
//
// Contract under test, through the public surface only:
// - the section is the `ODD` card, labelled `odd`, visible by default, and it
//   carries `placement: { after: "agents" }` so the host puts it right after the
//   native AGENTS rail part (S1), and its heading carries the count — `N odd` — as
//   `meta`, the way the CHANGES card reads `1 file` (S7 of odd-panel-groups);
// - the rows are the ODDs `load()` resolved, in THAT order (the walk and the
//   dedupe belong to the caller), at most FOUR of them (S2); more than four adds
//   ONE fifth row reading `N more`, dim and inert, while exactly four paint four
//   rows and no elision row at all;
// - a row's `meta` is the checkout name VERBATIM — `main` or the worktree name,
//   never a path (S5);
// - a row click defers `open({ name, docPath, checkoutRoot })` off the paint
//   path, once per click, with the target the row was built from, and never
//   after `dispose()`; a throwing opener never escapes into the host (S6);
// - `lines()` is a synchronous frame over an in-process snapshot: it never calls
//   `load()` on the paint path, a second frame inside the TTL reloads nothing,
//   and two stale frames queue ONE read;
// - a failed load keeps every row already on screen, marks the list `stale` and
//   starts no immediate retry; a failed FIRST load is still one error row, and no
//   seam — a throwing clock included — ever throws at the host;
// - `invalidate()` drops the rows and supersedes a result already on its way
//   (latest-wins), including a frame callback that outlived it;
// - the floor timer a `refreshFloorMs` asks for is unref'd, fires one read per
//   floor, and stops by itself once the section leaves the drawn window.
//
// Every seam is injected: the fake clock the tests own, a manual scheduler and
// manual timers, so nothing here waits on a real timer and nothing walks a real
// directory.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createOddRailSection } = require('../lib/odd-rail-section.js');

// ---------------------------------------------------------------------------
// The injected-seam harness.
// ---------------------------------------------------------------------------

// A manual scheduler: the section's refresh and its click callbacks are queued
// and only run when a test says so, so "deferred" is observable.
function manualSchedule() {
  const queue = [];
  return {
    schedule: (fn) => { queue.push(fn); },
    pending: () => queue.length,
    async flush() {
      while (queue.length > 0) {
        const fn = queue.shift();
        await fn();
      }
    },
  };
}

// Manual timers: the floor timer is observable as an armed handle, and the test
// decides when it fires. `unref` is recorded because an unref'd timer is what
// keeps the floor from being a reason for the process to stay alive.
function manualTimers() {
  const armed = [];
  return {
    setTimer: (fn, ms) => {
      const handle = {
        fn,
        ms,
        cleared: false,
        fired: false,
        unrefs: 0,
        unref() {
          handle.unrefs += 1;
          return handle;
        },
      };
      armed.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle) handle.cleared = true;
    },
    active: () => armed.filter((handle) => !handle.cleared && !handle.fired),
    fire() {
      const next = this.active()[0];
      if (!next) return false;
      next.fired = true;
      next.fn();
      return true;
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// One entry of what `load()` resolves: the ODD's name and the checkout it lives
// in. `docPath` and `checkoutRoot` are the values the click must hand over
// untouched, and `mtimeMs` stays on the entry the section never reads.
function oddItem(name, checkoutName, mtimeMs = 1000) {
  const root = checkoutName === 'main' ? '/repo/project' : `/repo/${checkoutName}`;
  return {
    name,
    docPath: `${root}/odd/tasks/${name}.md`,
    checkoutRoot: root,
    checkoutName,
    mtimeMs,
  };
}

// Four ODDs, handed over in an order that is deliberately NOT the `mtimeMs`
// order: the section draws the order it resolved, never a re-sort.
const FOUR = [
  oddItem('alpha', 'main', 500),
  oddItem('beta', 'wt-two', 900),
  oddItem('gamma', 'main', 100),
  oddItem('delta', 'wt-three', 700),
];

function targetOf(item) {
  return { name: item.name, docPath: item.docPath, checkoutRoot: item.checkoutRoot };
}

// ---------------------------------------------------------------------------
// S1: the card.
// ---------------------------------------------------------------------------

test('S1: the section is the ODD card, placed right after the native AGENTS part', () => {
  const handle = createOddRailSection({
    load: async () => [],
    open: () => {},
    schedule: () => {},
  });

  assert.equal(handle.section.id, 'odd-worktree.odd-rail', 'the section keeps its fixed id');
  assert.equal(handle.section.title, 'ODD', 'the heading reads ODD');
  assert.equal(handle.section.rowLabel, 'odd', 'the collapsed row label reads odd');
  assert.equal(handle.section.defaultVisible, true, 'the card is visible when it is registered');
  assert.deepEqual(handle.section.placement, { after: 'agents' },
    'the placement is exactly what puts the card after the AGENTS part');
  assert.deepEqual(Object.keys(handle.section.placement), ['after']);
  assert.equal(typeof handle.section.lines, 'function', 'the host draws the card through lines()');
  assert.equal(typeof handle.section.meta, 'function', 'the heading draws its `N odd` through meta()');
  assert.deepEqual(Object.keys(handle.section).sort(),
    ['defaultVisible', 'id', 'lines', 'meta', 'placement', 'rowLabel', 'title'],
    'the section is exactly the shape the bridge registers');
  assert.equal(typeof handle.invalidate, 'function', 'the session boundary has its seam');
});

// ---------------------------------------------------------------------------
// S2/S5: the rows.
// ---------------------------------------------------------------------------

test('S2/S5: exactly four ODDs paint four rows in the resolved order, and no elision row', async () => {
  const handle = createOddRailSection({
    load: async () => FOUR,
    open: () => {},
    schedule: () => {},
  });
  await handle.refresh();

  const rows = handle.section.lines({});
  assert.equal(rows.length, 4, 'four ODDs are four rows — no fifth line at all');
  assert.deepEqual(rows.map((row) => row.label), ['alpha', 'beta', 'gamma', 'delta'],
    'the resolved order is drawn: the section never re-sorts');
  assert.deepEqual(rows.map((row) => row.meta), ['main', 'wt-two', 'main', 'wt-three'],
    'each row carries its checkout name at the far right');
  assert.deepEqual(rows.map((row) => row.tone), ['text', 'text', 'text', 'text']);
  for (const row of rows) {
    assert.equal(typeof row.onClick, 'function', 'every ODD row is clickable (S6)');
    assert.deepEqual(Object.keys(row).sort(), ['label', 'meta', 'onClick', 'tone'],
      'a row is its label, its checkout name, its tone and its click');
  }
  assert.equal(rows.some((row) => row.onClick === null), false, 'no inert row is invented at four');
});

test('S2: more than four ODDs paint four rows plus ONE dim, inert `N more` row', async () => {
  const five = [
    oddItem('one', 'main'),
    oddItem('two', 'wt-a'),
    oddItem('three', 'wt-b'),
    oddItem('four', 'main'),
    oddItem('five', 'wt-c'),
  ];
  const handle = createOddRailSection({
    load: async () => five,
    open: () => {},
    schedule: () => {},
  });
  await handle.refresh();

  const rows = handle.section.lines({});
  assert.equal(rows.length, 5, 'four ODD rows and the one elision row');
  assert.deepEqual(rows.slice(0, 4).map((row) => row.label), ['one', 'two', 'three', 'four']);
  assert.equal(rows[4].label, '1 more', 'the elision counts what the four rows left out');
  assert.equal(rows[4].tone, 'dim', 'the elision row is the secondary tone');
  assert.equal(rows[4].onClick, null, 'the elision row is inert: there is nothing to open');
  assert.equal('meta' in rows[4], false, 'the elision row carries no checkout name');

  const many = Array.from({ length: 32 }, (_, index) => oddItem(`odd-${index + 1}`, index % 2 === 0 ? 'main' : 'wt-x'));
  const wide = createOddRailSection({
    load: async () => many,
    open: () => {},
    schedule: () => {},
  });
  await wide.refresh();
  const wideRows = wide.section.lines({});
  assert.equal(wideRows.length, 5, 'however many ODDs there are, the body stays five rows');
  assert.deepEqual(wideRows.slice(0, 4).map((row) => row.label), ['odd-1', 'odd-2', 'odd-3', 'odd-4'],
    'the four most recent are the four the walk put first');
  assert.equal(wideRows[4].label, '28 more', 'N is the TOTAL beyond the four, not a page size');
  assert.equal(wideRows[4].tone, 'dim');
  assert.equal(wideRows[4].onClick, null);
});

test('S5: the row meta is the checkout name verbatim — `main` or the worktree name, never a path', async () => {
  const items = [
    oddItem('in-main', 'main'),
    oddItem('in-worktree', 'feat-odd-rail-section'),
  ];
  const handle = createOddRailSection({
    load: async () => items,
    open: () => {},
    schedule: () => {},
  });
  await handle.refresh();

  const rows = handle.section.lines({});
  assert.equal(rows[0].meta, 'main', 'the main checkout keeps its own name');
  assert.equal(rows[1].meta, 'feat-odd-rail-section', 'a worktree is named, never located');
  assert.equal(rows[0].meta, items[0].checkoutName, 'the name goes through verbatim');
  assert.equal(rows[1].meta, items[1].checkoutName);
  for (const row of rows) {
    assert.equal(row.meta.includes('/'), false, `no row meta is a path (saw ${row.meta})`);
    assert.notEqual(row.meta, row.label, 'the checkout name is not the ODD name');
  }
});

// ---------------------------------------------------------------------------
// S6: the click.
// ---------------------------------------------------------------------------

test('S6: a row click defers open with that row\'s target, once, and never after dispose', async () => {
  const opened = [];
  const sched = manualSchedule();
  const handle = createOddRailSection({
    load: async () => FOUR,
    open: (target) => { opened.push(target); },
    schedule: sched.schedule,
  });
  await handle.refresh();
  const rows = handle.section.lines({});

  rows[0].onClick();
  assert.deepEqual(opened, [], 'the opener never runs on the paint path');
  await sched.flush();
  assert.deepEqual(opened, [targetOf(FOUR[0])],
    'one click opens that row\'s ODD with its own name, document and checkout root');

  rows[2].onClick();
  await sched.flush();
  assert.deepEqual(opened, [targetOf(FOUR[0]), targetOf(FOUR[2])],
    'every row carries ITS target, not whatever the snapshot holds when the human clicks');
  assert.deepEqual(Object.keys(opened[0]).sort(), ['checkoutRoot', 'docPath', 'name'],
    'the target is the three fields the opener names');

  handle.dispose();
  rows[1].onClick();
  assert.equal(sched.pending(), 0, 'a click the host retained schedules nothing after dispose');
  await sched.flush();
  assert.equal(opened.length, 2, 'open is never called after dispose');
});

test('S6: a throwing or rejecting opener never escapes the click and never costs the rows', async () => {
  const sched = manualSchedule();
  const handle = createOddRailSection({
    load: async () => FOUR,
    open: () => { throw new Error('no panel here'); },
    schedule: sched.schedule,
  });
  await handle.refresh();
  const ready = handle.section.lines({});

  let escaped = null;
  try {
    ready[0].onClick();
    await sched.flush();
  } catch (err) {
    escaped = err;
  }
  assert.equal(escaped, null, 'a failure on the click path never reaches the host');
  assert.deepEqual(handle.section.lines({}), ready, 'a failed dispatch never turns the list into an error row');

  const asyncSched = manualSchedule();
  const asyncHandle = createOddRailSection({
    load: async () => FOUR,
    open: () => Promise.reject(new Error('async opener failed')),
    schedule: asyncSched.schedule,
  });
  await asyncHandle.refresh();
  const asyncRows = asyncHandle.section.lines({});
  asyncRows[1].onClick();
  await asyncSched.flush();
  assert.deepEqual(asyncHandle.section.lines({}), asyncRows,
    'a rejected opener leaves the rows exactly as they were');
});

// ---------------------------------------------------------------------------
// The frame: one snapshot, one scheduled read, a TTL.
// ---------------------------------------------------------------------------

test('the frame never awaits: lines() schedules the read, and a frame inside the TTL reloads nothing', async () => {
  let clock = 1000;
  let loads = 0;
  let repaints = 0;
  const sched = manualSchedule();
  const handle = createOddRailSection({
    load: async () => {
      loads += 1;
      return FOUR;
    },
    open: () => {},
    schedule: sched.schedule,
    now: () => clock,
    ttlMs: 100,
    requestRepaint: () => { repaints += 1; },
  });

  assert.deepEqual(handle.section.lines({}), [{ label: 'loading…', tone: 'dim' }],
    'an absent snapshot draws the loading row');
  assert.equal(loads, 0, 'lines() never calls load() synchronously');
  assert.equal(sched.pending(), 1, 'the frame only SCHEDULES the read');
  await sched.flush();
  assert.equal(loads, 1);
  assert.equal(repaints, 1, 'a landed read asks the host to repaint once');
  assert.equal(handle.section.lines({}).length, 4);

  assert.equal(sched.pending(), 0, 'a frame inside the TTL schedules nothing');
  clock += 99;
  handle.section.lines({});
  assert.equal(sched.pending(), 0, 'still inside the TTL: no reload');
  assert.equal(loads, 1);

  clock += 1;
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'at the TTL one frame schedules exactly one read');
  await sched.flush();
  assert.equal(loads, 2);

  clock += 500;
  handle.section.lines({});
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'two stale frames still schedule ONE read');
});

test('a failed load keeps the previous rows, marks them stale and starts no immediate retry', async () => {
  let clock = 1000;
  let failing = false;
  const sched = manualSchedule();
  const handle = createOddRailSection({
    load: async () => {
      if (failing) throw new Error('scan failed');
      return FOUR;
    },
    open: () => {},
    schedule: sched.schedule,
    now: () => clock,
    ttlMs: 100,
  });

  await handle.refresh();
  const ready = handle.section.lines({});
  assert.equal(ready.length, 4);

  failing = true;
  clock += 200;
  await handle.refresh();
  assert.deepEqual(handle.section.lines({}), ready,
    'the rows stay exactly as they were: same rows, same order, same metadata');
  assert.equal(handle.section.lines({}).length, 4, 'a failure never blanks the card');

  handle.section.lines({});
  assert.equal(sched.pending(), 0,
    'the failed attempt starts the TTL, so the frame after it retries nothing');
  clock += 100;
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'once the TTL from the failed attempt passes, the frame retries');
});

test('a failure with nothing on screen is one error row, and no seam throws at the host', async () => {
  const handle = createOddRailSection({
    load: async () => { throw new Error('scan failed'); },
    open: () => {},
    schedule: () => {},
  });
  await handle.refresh();
  assert.deepEqual(handle.section.lines({}), [{ label: 'scan failed', tone: 'error' }],
    'a failed first read is ONE error row, not a throw');

  // A clock that throws costs the frame, never the host.
  const weird = createOddRailSection({
    load: async () => FOUR,
    open: () => {},
    schedule: () => {},
    now: () => { throw new Error('clock'); },
  });
  let rows = null;
  assert.doesNotThrow(() => { rows = weird.section.lines({}); }, 'a frame never throws');
  assert.ok(Array.isArray(rows), 'and it still answers rows');

  // A `load` that is not a function is the same one-line failure, never a crash.
  const missing = createOddRailSection({ open: () => {}, schedule: () => {} });
  await missing.refresh();
  assert.equal(missing.section.lines({}).length, 1);
  assert.equal(missing.section.lines({})[0].tone, 'error');
});

// ---------------------------------------------------------------------------
// The session boundary: latest-wins.
// ---------------------------------------------------------------------------

test('invalidate drops the rows and supersedes a result already on its way', async () => {
  const deferred = [];
  const handle = createOddRailSection({
    load: () => new Promise((resolve) => { deferred.push(resolve); }),
    open: () => {},
    schedule: () => {},
  });

  const inFlight = handle.refresh();
  assert.deepEqual(handle.section.lines({}), [{ label: 'loading…', tone: 'dim' }]);
  handle.invalidate();
  deferred[0](FOUR);
  await inFlight;
  assert.deepEqual(handle.section.lines({}), [{ label: 'loading…', tone: 'dim' }],
    'the superseded answer never paints the previous session\'s ODDs');

  // A frame callback already queued when the boundary fired starts no read.
  let loads = 0;
  const sched = manualSchedule();
  const queued = createOddRailSection({
    load: async () => {
      loads += 1;
      return FOUR;
    },
    open: () => {},
    schedule: sched.schedule,
  });
  queued.section.lines({});
  assert.equal(sched.pending(), 1);
  queued.invalidate();
  await sched.flush();
  assert.equal(loads, 0, 'a callback that outlived the invalidate does nothing');

  // After dispose the boundary is a no-op and never throws.
  queued.dispose();
  assert.doesNotThrow(() => queued.invalidate(), 'invalidate never throws');
  await sched.flush();
  assert.equal(loads, 0, 'a disposed section reads nothing');
});

// ---------------------------------------------------------------------------
// The floor timer.
// ---------------------------------------------------------------------------

test('the refresh timer is unref\'d, reads once per floor, and stops itself outside the drawn window', async () => {
  let clock = 1000;
  let loads = 0;
  const sched = manualSchedule();
  const timers = manualTimers();
  const handle = createOddRailSection({
    load: async () => {
      loads += 1;
      return FOUR;
    },
    open: () => {},
    schedule: sched.schedule,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => clock,
    refreshFloorMs: 20000,
    drawnWindowMs: 120000,
    ttlMs: 1,
  });

  handle.section.lines({});
  await sched.flush();
  assert.equal(loads, 1);
  const armed = timers.active();
  assert.equal(armed.length, 1, 'a drawn section arms ONE floor timer');
  assert.equal(armed[0].ms, 20000, 'at the floor the caller named');
  assert.equal(armed[0].unrefs, 1, 'the timer is unref\'d: never a reason for the process to stay alive');

  // The floor fires while the section is still drawn: one read, and the next
  // floor is armed by that fire itself.
  clock += 20000;
  assert.equal(timers.fire(), true);
  await tick();
  assert.equal(loads, 2, 'the floor timer starts exactly one read');
  assert.equal(timers.active().length, 1, 'and arms the next floor');

  // The host stops drawing: once the section is outside its drawn window, the
  // timer that fires starts nothing and arms nothing.
  clock += 200000;
  assert.equal(timers.fire(), true);
  await tick();
  assert.equal(loads, 2, 'a section nobody draws reads nothing');
  assert.equal(timers.active().length, 0, 'and the timer stops by itself');

  // A section disposed while drawn keeps no timer either.
  const disposeTimers = manualTimers();
  const disposed = createOddRailSection({
    load: async () => FOUR,
    open: () => {},
    schedule: () => {},
    setTimer: disposeTimers.setTimer,
    clearTimer: disposeTimers.clearTimer,
    refreshFloorMs: 20000,
  });
  disposed.section.lines({});
  assert.equal(disposeTimers.active().length, 1, 'the drawn section owns a timer');
  disposed.dispose();
  assert.equal(disposeTimers.active().length, 0, 'dispose clears the floor timer');
});

// ---------------------------------------------------------------------------
// S1 (odd-rail-session-scope): an empty body says so.
// ---------------------------------------------------------------------------

test('S1: a ready list with no associated ODD draws ONE dim `no ODD associated` row', async () => {
  const opened = [];
  const sched = manualSchedule();
  const handle = createOddRailSection({
    load: async () => [],
    open: (target) => { opened.push(target); },
    schedule: sched.schedule,
  });
  await handle.refresh();

  const rows = handle.section.lines({});
  // Exactly the `EMPTY_ROW` of lib/issues-section.js: one dim line, a copy per
  // frame, and no click — there is nothing behind it to open.
  assert.deepEqual(rows, [{ label: 'no ODD associated', tone: 'dim' }]);
  assert.equal('onClick' in rows[0], false, 'the empty line is inert, like the issues one');
  assert.deepEqual(opened, [], 'drawing the empty line opens nothing');
});

test('S1: the empty line is a state, not a failure: another frame inside the TTL keeps it, and a later list replaces it', async () => {
  let items = [];
  const handle = createOddRailSection({
    load: async () => items,
    open: () => {},
    schedule: () => {},
  });
  await handle.refresh();
  assert.deepEqual(handle.section.lines({}), [{ label: 'no ODD associated', tone: 'dim' }]);
  // A second frame reads the same snapshot: no read, the same one line.
  assert.deepEqual(handle.section.lines({}), [{ label: 'no ODD associated', tone: 'dim' }]);

  items = FOUR;
  await handle.refresh();
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['alpha', 'beta', 'gamma', 'delta'],
    'a list replaces the empty line, and its rows keep their own shape');
});

// ---------------------------------------------------------------------------
// S7 (odd-panel-groups): the heading carries the count, like the CHANGES card's
// `1 file` — `N odd`, lowercase and in the host's muted role.
// ---------------------------------------------------------------------------

test('S7: the heading answers `N odd`, and nothing before a read', async () => {
  const items = [oddItem('alpha', 'main'), oddItem('beta', 'wt-a'), oddItem('gamma', 'main')];
  const handle = createOddRailSection({
    load: async () => items,
    open: () => {},
    schedule: () => {},
  });

  assert.equal(handle.section.meta({}), undefined, 'no read yet: no count is invented');
  await handle.refresh();
  assert.equal(handle.section.meta({}), '3 odd', 'the count is every ODD the rows are made of');
  assert.equal(typeof handle.section.meta, 'function', 'the host draws it through meta()');
});

test('S7: one ODD and an empty list both read as a lowercase count', async () => {
  const one = createOddRailSection({ load: async () => [oddItem('alpha', 'main')], open: () => {}, schedule: () => {} });
  await one.refresh();
  assert.equal(one.section.meta({}), '1 odd', 'the singular number keeps the same word');

  const none = createOddRailSection({ load: async () => [], open: () => {}, schedule: () => {} });
  await none.refresh();
  assert.equal(none.section.meta({}), '0 odd', 'an empty section still counts nothing honestly');
});

test('S7: the count is every loaded ODD, not only the four the card can draw', async () => {
  const items = Array.from({ length: 9 }, (_, index) => oddItem(`odd-${index}`, index === 0 ? 'main' : 'wt'));
  const handle = createOddRailSection({ load: async () => items, open: () => {}, schedule: () => {} });
  await handle.refresh();
  assert.equal(handle.section.meta({}), '9 odd', 'the cap on DRAWN rows never caps the count');
});

test('S7: a stale list says so, and a failed first read answers no count', async () => {
  let fail = false;
  const items = [oddItem('alpha', 'main'), oddItem('beta', 'wt-a')];
  const handle = createOddRailSection({ load: async () => { if (fail) throw new Error('read failed'); return items; }, open: () => {}, schedule: () => {} });
  await handle.refresh();
  assert.equal(handle.section.meta({}), '2 odd');
  fail = true;
  await handle.refresh();
  assert.equal(handle.section.meta({}), '2 odd · stale', 'the rows on screen are not live, and the count says so');

  const broken = createOddRailSection({ load: async () => { throw new Error('read failed'); }, open: () => {}, schedule: () => {} });
  await broken.refresh();
  assert.equal(broken.section.meta({}), undefined, 'no successful read, no count');
});

test('S7: the heading only READS the snapshot — it never starts a load', async () => {
  let reads = 0;
  const handle = createOddRailSection({
    load: async () => { reads += 1; return [oddItem('alpha', 'main')]; },
    open: () => {},
    schedule: () => {},
  });
  assert.equal(handle.section.meta({}), undefined);
  assert.equal(reads, 0, 'a collapsed card draws its heading alone and pays no read for it');
});

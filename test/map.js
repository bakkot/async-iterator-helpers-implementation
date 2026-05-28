import { map } from '../map.js';
import {
  makeLog,
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
} from './utils.js';

// Test 1: the simple, sequential case. Pull one at a time, settle, observe.
// Establishes the basic protocol: each consumer next() pulls the source once,
// the mapper transforms the value, and `done` propagates.
async function testSequential(t) {
  const { log } = makeLog();
  const src = controlledSource(log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  await flushMicrotasks();
  t.check('first next() pulled the source exactly once', src.pullCount(), 1);
  src.yield(0, 1);
  t.check('r0 = 10', await r0, { value: 10, done: false });

  const r1 = mapped.next();
  await flushMicrotasks();
  src.yield(1, 2);
  t.check('r1 = 20', await r1, { value: 20, done: false });

  const r2 = mapped.next();
  await flushMicrotasks();
  src.finish(2);
  t.check('r2 is done', await r2, { value: undefined, done: true });

  t.check('underlying was not closed (clean exhaustion)', src.returned, false);
}

// Test 2: concurrency. Fire two next() calls before settling anything, so both
// underlying pulls are in flight at once. Then settle the *second* pull first.
//
// We expect:
//   - both consumer calls triggered concurrent underlying pulls;
//   - r1 is allowed to settle (in wall-clock terms) BEFORE r0 — "later calls
//     may settle earlier";
//   - yet, read in call order, the values match the sequential sequence:
//     r0 carries the first value, r1 the second.
async function testConcurrentOutOfOrder(t) {
  const { log, entries } = makeLog();
  const src = controlledSource(log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  const r1 = mapped.next();
  track(log, 'r0', r0);
  track(log, 'r1', r1);
  await flushMicrotasks();

  // Settle the SECOND pull first, then the first.
  src.yield(1, 2);
  await flushMicrotasks();
  src.yield(0, 1);
  await flushMicrotasks();

  // The whole event trace captures everything at once: both consumer calls
  // issued concurrent underlying pulls (#0 then #1), r1 settled *before* r0
  // ("later calls may settle earlier"), and yet each call received its
  // in-call-order value (r0 -> first value 10, r1 -> second value 20).
  t.compareArray('full event log', entries, [
    'src.next() #0',
    'src.next() #1',
    'r1 resolved {"value":20,"done":false}',
    'r0 resolved {"value":10,"done":false}',
  ]);
}

runTests([
  ['map: sequential pulls', testSequential],
  ['map: concurrent out-of-order settlement', testConcurrentOutOfOrder],
]);

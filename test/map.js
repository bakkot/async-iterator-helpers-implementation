import { map } from '../map.js';
import {
  makeLog,
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';

let tests = [];

// The simple, sequential case. Pull one at a time, settle, observe.
// Establishes the basic protocol: each consumer next() pulls the source once,
// the mapper transforms the value, and `done` propagates.
tests.push(['map: sequential pulls', async function testSequential(t) {
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
}]);

// Concurrency. Fire two next() calls before settling anything, so both
// underlying pulls are in flight at once. Then settle the *second* pull first.
//
// We expect:
//   - both consumer calls triggered concurrent underlying pulls;
//   - r1 is allowed to settle (in wall-clock terms) BEFORE r0 — "later calls
//     may settle earlier";
//   - yet, read in call order, the values match the sequential sequence:
//     r0 carries the first value, r1 the second.
tests.push(['map: concurrent out-of-order settlement', async function testConcurrentOutOfOrder(t) {
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
}]);

// Concurrency through the mapper itself. With an async mapper, two in-flight
// next() calls should drive the pipeline concurrently end-to-end: both
// underlying pulls *and* both mapper invocations are outstanding at the same
// time. The mapper is then settled out of order to show the result promises
// settle out of order while still carrying their in-call-order values.
tests.push(['map: concurrent async mapper, settled out of order', async function testConcurrentMapper(t) {
  const { log, entries } = makeLog();
  const src = controlledSource(log, 'src');
  const fn = controlledFn(log, 'fn');
  const mapped = map(src.iterator, fn.fn);

  const r0 = mapped.next();
  const r1 = mapped.next();
  track(log, 'r0', r0);
  track(log, 'r1', r1);
  await flushMicrotasks();

  // Both underlying pulls are outstanding; the mapper hasn't run yet (it has
  // nothing to map until the source yields).
  t.check('two concurrent pulls before any source value', src.pullCount(), 2);
  t.check('mapper not called yet', fn.callCount(), 0);

  // Feed both source values. Now the mapper should be invoked for both,
  // concurrently, without waiting for the first mapping to finish.
  src.yield(0, 1);
  src.yield(1, 2);
  await flushMicrotasks();
  t.check('both mapper invocations in flight concurrently', fn.callCount(), 2);

  // Settle the SECOND mapping first, then the first.
  fn.resolve(1, 'B');
  await flushMicrotasks();
  fn.resolve(0, 'A');
  await flushMicrotasks();

  // End-to-end concurrent trace: pulls issued together, both mappings run
  // before either resolves, the second mapping settles first (r1 before r0),
  // and each call still receives its own value (r0 -> map of 1, r1 -> map of 2).
  t.compareArray('full event log', entries, [
    'src.next() #0',
    'src.next() #1',
    'fn(1) #0',
    'fn(2) #1',
    'r1 resolved {"value":"B","done":false}',
    'r0 resolved {"value":"A","done":false}',
  ]);
}]);

runTests(tests);

import { map } from '../map.js';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';

let tests = [];

// The simple, sequential case. Pull one at a time, settle, observe. Establishes
// the basic protocol: each consumer next() pulls the source once, the mapper
// transforms the value, and `done` propagates without closing the source.
tests.push(['map: sequential pulls', async function testSequential(t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the source once', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('r0 maps 1 -> 10', ['r0 resolved {"value":10,"done":false}']);

  const r1 = mapped.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('second next() pulls again', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('r1 maps 2 -> 20', ['r1 resolved {"value":20,"done":false}']);

  const r2 = mapped.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('third next() pulls again', ['src.next() #2']);

  src.finish(2);
  await flushMicrotasks();
  // `done` propagates and the source is NOT closed on clean exhaustion — the
  // absence of any `src.return()` entry here is the assertion.
  t.expectLog('r2 is done, source left open', ['r2 resolved {"done":true}']);
}]);

// Concurrency in the underlying iterator. Fire two next() calls before settling
// anything, so both underlying pulls are in flight at once, then settle the
// *second* pull first. r1 is allowed to settle before r0 ("later calls may
// settle earlier"), yet each call still receives its own in-call-order value.
tests.push(['map: concurrent out-of-order settlement', async function testConcurrentOutOfOrder(t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  const r1 = mapped.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('second pull settles first -> r1 resolves first', [
    'r1 resolved {"value":20,"done":false}',
  ]);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('first pull settles -> r0 resolves with its own value', [
    'r0 resolved {"value":10,"done":false}',
  ]);
}]);

// Concurrency through the mapper itself. With an async mapper, two in-flight
// next() calls drive the pipeline concurrently end-to-end: both underlying
// pulls and then both mapper invocations are outstanding at the same time. The
// mapper is settled out of order to show the results settle out of order while
// still carrying their in-call-order values.
tests.push(['map: concurrent async mapper, settled out of order', async function testConcurrentMapper(t) {
  const src = controlledSource(t.log, 'src');
  const fn = controlledFn(t.log, 'fn');
  const mapped = map(src.iterator, fn.fn);

  const r0 = mapped.next();
  const r1 = mapped.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  // Both pulls are outstanding; the mapper hasn't run (nothing to map yet) —
  // shown by the absence of any fn(...) entry.
  t.expectLog('two concurrent pulls, mapper not yet called', [
    'src.next() #0',
    'src.next() #1',
  ]);

  // Feed both source values; the mapper is now invoked for both, concurrently,
  // without waiting for the first mapping to finish (both fn entries, no result
  // yet).
  src.yield(0, 1);
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('both mapper invocations in flight concurrently', [
    'fn(1) #0',
    'fn(2) #1',
  ]);

  // Settle the SECOND mapping first, then the first.
  fn.resolve(1, 'B');
  await flushMicrotasks();
  t.expectLog('second mapping settles first -> r1 first', [
    'r1 resolved {"value":"B","done":false}',
  ]);

  fn.resolve(0, 'A');
  await flushMicrotasks();
  t.expectLog('first mapping settles -> r0 with its own value', [
    'r0 resolved {"value":"A","done":false}',
  ]);
}]);

runTests(tests);

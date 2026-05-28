import { filter } from '../filter.js';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';

let tests = [];

// NOTE: filter.js is still a placeholder, so these tests are expected to FAIL
// for now. They exist to pin down the intended concurrent semantics. They are a
// hand-picked illustrative set, not the exhaustive suite (that comes later).
//
// The thing that makes filter harder than map: a consumer next() is not 1:1
// with an underlying pull. A value whose predicate resolves *false* is dropped,
// so a single consumer call may have to consume several underlying values. The
// i-th value that PASSES the predicate (in pull order) is what the i-th consumer
// call receives. That means a later call generally cannot settle before an
// earlier one — its value depends on which earlier values were dropped. The lone
// exception is { done: true }, which can settle early (a predicate can only
// remove values, never add them).

// The simple sequential case, including a drop. The first source value fails the
// predicate and is dropped, so the helper must pull again to find a value for the
// (single) consumer call. Establishes the basic protocol: a passing value is
// delivered, a failing one is silently dropped and triggers another pull.
tests.push(['filter: sequential, drops a value then delivers the next', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the source once', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the first value', ['pred(1) #0']);

  // Predicate says false: value 1 is dropped, and because the consumer call is
  // still unsatisfied the helper must pull again.
  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('a dropped value triggers another pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the second value', ['pred(2) #1']);

  // This one passes, so it satisfies the consumer call.
  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('the passing value is delivered', ['r0 resolved {"value":2,"done":false}']);
}]);

// Clean exhaustion: a done from the underlying propagates as done and does NOT
// close the source (no src.return()), exactly as in map.
tests.push(['filter: done propagates and leaves the source open', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.finish(0);
  await flushMicrotasks();
  // No src.return() entry: clean exhaustion does not close the source.
  t.expectLog('done propagates, source left open', ['r0 resolved {"done":true}']);

  const r1 = f.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a later call is done', ['r1 resolved {"done":true}']);
}]);

// The ordering rule that distinguishes filter from map: a later consumer call
// cannot settle with a VALUE before an earlier one, because the earlier call's
// value depends on which values were dropped. Here both predicates ultimately
// pass, but the SECOND predicate resolves first — and still r1 must wait for r0.
tests.push(['filter: a later value cannot settle before an earlier one', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.yield(0, 10);
  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('both predicates in flight', ['pred(10) #0', 'pred(20) #1']);

  // The later predicate resolves first. Even though pull #1's value is known to
  // pass, it cannot be handed to r1 yet: if pull #0 turns out to be dropped, this
  // value belongs to r0 instead. So nothing settles.
  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('later passing value cannot settle ahead of the earlier call', []);

  // Now the earlier predicate resolves (also passing). r0 takes value 10, then
  // r1 takes value 20 — both in call order.
  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('both settle in call order', [
    'r0 resolved {"value":10,"done":false}',
    'r1 resolved {"value":20,"done":false}',
  ]);
}]);

// The key oddity from the spec. Three concurrent calls issue three pulls. The
// THIRD pull is done while the first two return (still-pending) values, so we
// already know the sequence has at most two values — the third consumer call can
// settle done immediately. Then the first predicate resolves *false*, dropping
// that value: now at most one value remains, so the SECOND call can settle done
// too. The first call still cannot settle: it depends on the second predicate.
tests.push(['filter: done lets trailing calls settle while an earlier one is blocked', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  const r2 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('three concurrent pulls', ['src.next() #0', 'src.next() #1', 'src.next() #2']);

  // Pulls #0 and #1 yield values; their predicates are invoked and left pending.
  src.yield(0, 1);
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('first two predicates in flight', ['pred(1) #0', 'pred(2) #1']);

  // Pull #2 is done. Values can come only from pulls #0 and #1, so there are at
  // most two values: the third consumer call can never receive one and settles
  // done now. r0 and r1 stay pending.
  src.finish(2);
  await flushMicrotasks();
  t.expectLog('done caps the sequence at two values -> r2 done', ['r2 resolved {"done":true}']);

  // Predicate #0 resolves false: value 1 is dropped. Now at most one value (from
  // pull #1) remains, so the second consumer call settles done. r0 still waits on
  // predicate #1 — it cannot settle until we know whether value 2 passes.
  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('a dropped value lowers the cap to one -> r1 done', ['r1 resolved {"done":true}']);

  // Predicate #1 passes: value 2 is the sole survivor and goes to the first call.
  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('the surviving value feeds the first call', ['r0 resolved {"value":2,"done":false}']);
}]);

// Error handling mirrors map: an error from the predicate closes the underlying
// iterator (.return()), the result rejects, and the helper is done thereafter.
tests.push(['filter: predicate error closes the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('predicate invoked', ['pred(1) #0']);

  pred.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('predicate error -> close source, reject', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  const r1 = f.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

runTests(tests);

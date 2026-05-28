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

// A done observed while an earlier pull is still pending releases *all* the
// trailing blocked calls at once (not one per event). Here pull #1 is done with
// pull #0 still pending, so at most one value is possible: both r1 and r2 settle
// done together, while r0 stays blocked on its predicate.
tests.push(['filter: a done releases all trailing blocked calls at once', async function (t) {
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

  // Pull #0 yields a value; its predicate is invoked and left pending.
  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('first predicate in flight', ['pred(1) #0']);

  // Pull #1 is done. Values can come only from pull #0, so at most one value:
  // the second and third calls both settle done in this one step.
  src.finish(1);
  await flushMicrotasks();
  t.expectLog('done settles both trailing calls together', [
    'r2 resolved {"done":true}',
    'r1 resolved {"done":true}',
  ]);

  // The first call was never affected; its value still arrives.
  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('the first call still delivers its value', ['r0 resolved {"value":1,"done":false}']);
}]);

// Two concurrent calls where the first value is dropped. The drop must reissue
// a pull to replace the lost value, and the surviving values are handed to the
// calls in call order: the first survivor to r0, the second to r1 — regardless
// of which pull they came from.
tests.push(['filter: a dropped value reissues a pull; survivors go to calls in order', async function (t) {
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

  // Pull #0 drops, so a replacement pull #2 is issued. Pull #1 passes, but as
  // the first surviving value it belongs to r0 — not r1.
  pred.resolve(0, false);
  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('drop reissues a pull; the first survivor goes to r0', [
    'src.next() #2',
    'r0 resolved {"value":20,"done":false}',
  ]);

  src.yield(2, 30);
  await flushMicrotasks();
  t.expectLog('predicate runs on the replacement value', ['pred(30) #2']);

  pred.resolve(2, true);
  await flushMicrotasks();
  t.expectLog('the second survivor goes to r1', ['r1 resolved {"value":30,"done":false}']);
}]);

// Values are not lost: a later predicate error closes the source and ends the
// helper, but an earlier in-flight value still reaches its call. The error then
// reaches the call that was scanning into it.
tests.push(['filter: a later error does not lose an earlier in-flight value', async function (t) {
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

  // The later predicate errors first, closing the source. r0 is still pending on
  // pull #0, so nothing is delivered to it yet.
  pred.reject(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('later predicate error closes the source', ['src.return() #0']);

  // Pull #0 passes: its value is not lost and still reaches r0; only then does
  // the error reach r1.
  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('earlier value delivered, then the error reaches r1', [
    'r0 resolved {"value":10,"done":false}',
    'r1 rejected boom',
  ]);
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

// A predicate error is treated exactly like resolving `true` — the value fills
// its slot's position — except that the stream ends there, the source is closed,
// and that position rejects instead of delivering. So the error caps the
// sequence just like a done: trailing calls can settle done immediately, even
// while an earlier call is still blocked.
tests.push(['filter: a predicate error settles trailing calls done while an earlier call is blocked', async function (t) {
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

  // Only pull #1 yields (pull #0 stays pending); its predicate is invoked.
  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the second value', ['pred(20) #0']);

  // The predicate errors. Slot #1 still occupies a value position (like `true`)
  // and ends the stream: the source closes, and since values can only come from
  // slots #0 and #1, the third call can never get one and settles done now —
  // while r0 remains blocked on pull #0.
  pred.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('error closes the source and settles the trailing call done', [
    'src.return() #0',
    'r2 resolved {"done":true}',
  ]);

  // Pull #0 yields a passing value: it still reaches r0 (not lost). Only then
  // does the error reach r1 — the call at the erroring value's position.
  src.yield(0, 10);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the first value', ['pred(10) #1']);

  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('earlier value delivered, then the error reaches r1', [
    'r0 resolved {"value":10,"done":false}',
    'r1 rejected boom',
  ]);
}]);

// Like the done case, a single predicate error can release several trailing
// blocked calls at once: with pull #0 still pending, slots #0 and #1 are the
// only possible value positions, so both r2 and r3 settle done together.
tests.push(['filter: a predicate error releases all trailing blocked calls at once', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  const r2 = f.next();
  const r3 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  track(t.log, 'r3', r3);
  await flushMicrotasks();
  t.expectLog('four concurrent pulls', [
    'src.next() #0', 'src.next() #1', 'src.next() #2', 'src.next() #3',
  ]);

  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the second value', ['pred(20) #0']);

  pred.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('error closes the source and settles both trailing calls done', [
    'src.return() #0',
    'r3 resolved {"done":true}',
    'r2 resolved {"done":true}',
  ]);
}]);

runTests(tests);

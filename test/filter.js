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

// The done slot may arrive after earlier head slots have already been compacted
// away. The done position must still be interpreted relative to the current
// slot window, not the original pull history.
tests.push(['filter: done after head compaction still drains trailing calls', async function (t) {
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

  src.yield(0, 10);
  await flushMicrotasks();
  t.expectLog('first predicate in flight', ['pred(10) #0']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('head value settles and compacts away', ['r0 resolved {"value":10,"done":false}']);

  src.finish(1);
  await flushMicrotasks();
  t.expectLog('done is relative to the compacted window', [
    'r2 resolved {"done":true}',
    'r1 resolved {"done":true}',
  ]);
}]);

// Once a clean done has settled every outstanding consumer, later completions
// from pulls that were already issued must be harmless. They may update their
// own slot bookkeeping, but there is no consumer left to resolve or reject.
tests.push(['filter: in-flight pull completion after all calls are done is harmless', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  // Pull #0 is done, so no values can exist for either call. Both settle done
  // even though pull #1 is still in flight.
  src.finish(0);
  await flushMicrotasks();
  t.expectLog('earlier done settles every outstanding call', [
    'r1 resolved {"done":true}',
    'r0 resolved {"done":true}',
  ]);

  // The later in-flight pull completing after that should have no observable
  // consumer effect.
  src.finish(1);
  await flushMicrotasks();
  t.expectLog('late completion is ignored', []);
}]);

// If an already-issued pull produces a value after a clean done has drained all
// consumers, the terminal cutoff ignores it before the predicate runs.
tests.push(['filter: late value after terminal done has no consumer effect', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.finish(0);
  await flushMicrotasks();
  t.expectLog('done drains all consumers', [
    'r1 resolved {"done":true}',
    'r0 resolved {"done":true}',
  ]);

  src.yield(1, 99);
  await flushMicrotasks();
  t.expectLog('late value is ignored', []);
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

// A drop lowers the possible value count, but before a terminal event the
// helper must not use that finite-looking count to settle trailing calls done:
// another replacement pull can still produce more values.
tests.push(['filter: non-terminal drops do not drain trailing calls', async function (t) {
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

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('first predicate in flight', ['pred(1) #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('drop reissues a pull but does not settle anyone done', ['src.next() #3']);

  src.yield(1, 2);
  src.yield(2, 3);
  src.yield(3, 4);
  await flushMicrotasks();
  t.expectLog('remaining predicates run', ['pred(2) #1', 'pred(3) #2', 'pred(4) #3']);

  pred.resolve(1, true);
  pred.resolve(2, true);
  pred.resolve(3, true);
  await flushMicrotasks();
  t.expectLog('all waiting calls still receive values', [
    'r0 resolved {"value":2,"done":false}',
    'r1 resolved {"value":3,"done":false}',
    'r2 resolved {"value":4,"done":false}',
  ]);
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

// A predicate error is treated exactly like resolving `true` — the erroring
// value still occupies its position — except that position *rejects*, the
// source is closed, and *future* next() calls get done. Crucially it does NOT
// cap the sequence: calls already vended are still served by the pulls already
// in flight (a predicate failure does not exhaust the source), so their values
// are not lost. Here the third call, already vended, ultimately receives a real
// value rather than being forced to done by the error.
tests.push(['filter: a predicate error does not force an already-vended call to done', async function (t) {
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

  // The predicate errors. The source is closed, but nothing settles yet: r0/r1
  // are still in order behind pull #0, and r2 is NOT forced to done — it is
  // still owed whatever pull #2 produces.
  pred.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('error closes the source; no call is forced to done', ['src.return() #0']);

  // Pull #0 yields a passing value: it reaches r0 (not lost). Only then does the
  // error reach r1 — the call at the erroring value's position.
  src.yield(0, 10);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the first value', ['pred(10) #1']);

  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('earlier value delivered, then the error reaches r1', [
    'r0 resolved {"value":10,"done":false}',
    'r1 rejected boom',
  ]);

  // r2's own in-flight pull resolves with a passing value: it gets that value,
  // done:false — the error never turned it into a done.
  src.yield(2, 30);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the third value', ['pred(30) #2']);

  pred.resolve(2, true);
  await flushMicrotasks();
  t.expectLog('the already-vended third call still delivers a value', [
    'r2 resolved {"value":30,"done":false}',
  ]);
}]);

// Mirrors the map invariant "an in-flight call may resolve done:false after an
// earlier error": the first predicate errors (rejecting r0 and closing the
// source), yet r1 — already in flight — still resolves with its own value.
tests.push(['filter: an in-flight call still resolves with a value after an earlier error', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.yield(0, 1);
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('both predicates in flight', ['pred(1) #0', 'pred(2) #1']);

  // The earlier predicate errors: r0 rejects and the source closes. r1 is left
  // pending on its own predicate, not forced to done.
  pred.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('earlier error rejects r0 and closes the source', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('later in-flight call still resolves done:false', [
    'r1 resolved {"value":2,"done":false}',
  ]);
}]);

// We must not leave a vended promise unsettled. After an error the source is
// closed and no replacement pulls happen, so a vended call whose value would
// have required a *new* pull (its in-flight slot drops) settles done rather than
// hanging.
tests.push(['filter: after an error, a vended call that would need a new pull settles done', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the first value', ['pred(1) #0']);

  // The first predicate errors: r0 (at that position) rejects and the source
  // closes. r1 is left in flight on pull #1.
  pred.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('error rejects r0 and closes the source', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the second value', ['pred(2) #1']);

  // Pull #1 drops. Normally that reissues a pull to satisfy r1, but the source
  // is closed — so r1 can never be served and settles done instead of hanging.
  pred.resolve(1, false);
  await flushMicrotasks();
  t.expectLog('the un-serviceable vended call settles done', ['r1 resolved {"done":true}']);
}]);

// Same return()-then-drop shape as above, but after a head value has already
// compacted out of the slot window. This exercises the value ceiling without
// absolute consumer positions.
tests.push(['filter: return after head compaction still drains an unserviceable call', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.yield(0, 1);
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('both predicates in flight', ['pred(1) #0', 'pred(2) #1']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('head value settles before return', ['r0 resolved {"value":1,"done":false}']);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return closes after compaction', ['src.return() #0', 'ret resolved {"done":true}']);

  pred.resolve(1, false);
  await flushMicrotasks();
  t.expectLog('remaining call settles done without a replacement pull', ['r1 resolved {"done":true}']);
}]);

// return() closes the source the same way, so it too must not strand a vended
// call whose value would need a new pull.
tests.push(['filter: after return(), a vended call that would need a new pull settles done', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a pull is in flight', ['src.next() #0']);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the source', ['src.return() #0', 'ret resolved {"done":true}']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('predicate still runs on the in-flight value', ['pred(1) #0']);

  // The in-flight value is dropped; with the source closed there is no
  // replacement pull, so r0 settles done instead of hanging.
  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('the un-serviceable vended call settles done', ['r0 resolved {"done":true}']);
}]);

runTests(tests);

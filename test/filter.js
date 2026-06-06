import { filter } from '../filter.js';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';

let tests = [];
let xfailed = [];

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

// If a dropped value requires a replacement pull and that replacement .next()
// throws synchronously, the still-unsatisfied consumer call observes that source
// error. It must not be converted into done.
tests.push(['filter: synchronous source throw from replacement pull rejects the pending call', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the source once', ['src.next() #0']);

  src.throwNext(new Error('source throw 1'));

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('predicate invoked on the first value', ['pred(1) #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('replacement pull throws and rejects the pending call', [
    'src.next() #1 (throws)',
    'r0 rejected source throw 1',
  ]);
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
    'r1 resolved {"done":true}',
    'r2 resolved {"done":true}',
  ]);

  // The first call was never affected; its value still arrives.
  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('the first call still delivers its value', ['r0 resolved {"value":1,"done":false}']);
}]);

// Regression from the bounded-exhaustive suite: if a later done wall is observed
// before an earlier done wall, truncating the later done must not decrement the
// possible-value count a second time. The first pending value still belongs to
// r0 after r1/r2 are known done.
tests.push(['filter: earlier done after later done does not erase a pending value', async function (t) {
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
  t.expectLog('first predicate is pending', ['pred(1) #0']);

  src.finish(2);
  await flushMicrotasks();
  t.expectLog('later done releases only the trailing call', ['r2 resolved {"done":true}']);

  src.finish(1);
  await flushMicrotasks();
  t.expectLog('earlier done releases r1 but leaves r0 pending', ['r1 resolved {"done":true}']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('pending value still reaches r0', ['r0 resolved {"value":1,"done":false}']);
}]);

// Regression from the bounded-exhaustive suite: an underlying error that
// arrives before an already-observed done wall must not reopen later pulls that
// the done wall already made unobservable.
tests.push(['filter: earlier underlying error after later done does not reopen truncated pulls', async function (t) {
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

  src.finish(1);
  await flushMicrotasks();
  t.expectLog('done releases trailing calls', [
    'r1 resolved {"done":true}',
    'r2 resolved {"done":true}',
  ]);

  src.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('earlier underlying error rejects only r0', ['r0 rejected boom']);

  src.yield(2, 99);
  await flushMicrotasks();
  t.expectLog('truncated later pull remains ignored', []);
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
    'r1 resolved {"done":true}',
    'r2 resolved {"done":true}',
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
    'r0 resolved {"done":true}',
    'r1 resolved {"done":true}',
  ]);

  // The later in-flight pull completing after that should have no observable
  // consumer effect.
  src.finish(1);
  await flushMicrotasks();
  t.expectLog('late completion is ignored', []);
}]);

// return() means no more demand, not "cancel the promises already handed out".
// Already-vended calls still observe their in-flight source values if those
// values pass the predicate, while calls made after return() are done.
tests.push(['filter: return() does not cancel already-requested passing values', async function (t) {
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
  t.expectLog('three pulls are in flight', ['src.next() #0', 'src.next() #1', 'src.next() #2']);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the source and resolves', [
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  src.yield(0, 10);
  src.yield(1, 20);
  src.yield(2, 30);
  await flushMicrotasks();
  t.expectLog('predicates still run for already-requested values', [
    'pred(10) #0',
    'pred(20) #1',
    'pred(30) #2',
  ]);

  pred.resolve(0, true);
  pred.resolve(1, true);
  pred.resolve(2, true);
  await flushMicrotasks();
  t.expectLog('already-requested passing values are delivered', [
    'r0 resolved {"value":10,"done":false}',
    'r1 resolved {"value":20,"done":false}',
    'r2 resolved {"value":30,"done":false}',
  ]);

  const r3 = f.next();
  track(t.log, 'r3', r3);
  await flushMicrotasks();
  t.expectLog('a next() after return() is done', ['r3 resolved {"done":true}']);
}]);

// A source error rejects only the call that depends on that source position.
// Other already-vended calls remain tied to their own source/predicate work.
tests.push(['filter: source error does not reject unrelated outstanding calls', async function (t) {
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
  t.expectLog('three pulls are in flight', ['src.next() #0', 'src.next() #1', 'src.next() #2']);

  src.throw(0, new Error('source reject 0'));
  await flushMicrotasks();
  t.expectLog('only the dependent call rejects', ['r0 rejected source reject 0']);

  src.yield(1, 20);
  src.yield(2, 30);
  await flushMicrotasks();
  t.expectLog('unrelated predicates still run', ['pred(20) #0', 'pred(30) #1']);

  pred.resolve(0, true);
  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('unrelated outstanding calls still receive values', [
    'r1 resolved {"value":20,"done":false}',
    'r2 resolved {"value":30,"done":false}',
  ]);

  const r3 = f.next();
  track(t.log, 'r3', r3);
  await flushMicrotasks();
  t.expectLog('a later next() after the source error is done', ['r3 resolved {"done":true}']);
}]);

// A later source done can prove trailing calls are done even while an earlier
// source pull has not yielded anything yet. The earlier call still receives its
// value if that pending pull later produces one that passes.
tests.push(['filter: source done settles trailing calls while an earlier source pull is pending', async function (t) {
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
  t.expectLog('three pulls are in flight', ['src.next() #0', 'src.next() #1', 'src.next() #2']);

  src.finish(1);
  await flushMicrotasks();
  t.expectLog('done from pull #1 settles trailing calls', [
    'r1 resolved {"done":true}',
    'r2 resolved {"done":true}',
  ]);

  src.yield(0, 10);
  await flushMicrotasks();
  t.expectLog('the earlier source value still runs the predicate', ['pred(10) #0']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('the earlier call still delivers its value', ['r0 resolved {"value":10,"done":false}']);
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
    'r0 resolved {"done":true}',
    'r1 resolved {"done":true}',
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

// If return() has stopped new demand, an earlier dropped value must retire the
// latest pending request, not the earlier one. A later in-flight survivor can
// still move forward to satisfy the earlier request.
tests.push(['filter: after return(), an earlier drop retires the latest pending request', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two pulls are in flight', ['src.next() #0', 'src.next() #1']);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the source', ['src.return() #0', 'ret resolved {"done":true}']);

  src.yield(0, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the earlier value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('the later pending request is retired', ['r1 resolved {"done":true}']);

  src.yield(1, 'v1');
  await flushMicrotasks();
  t.expectLog('predicate runs for the later value', ['pred("v1") #1']);

  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('the later survivor satisfies the earlier request', [
    'r0 resolved {"value":"v1","done":false}',
  ]);
}]);

// Same return() shape, but the filtered-out value comes from the later source
// pull while the earlier pull is still pending. The later request is done; the
// earlier request still waits for its own in-flight source work.
tests.push(['filter: after return(), an out-of-order drop retires the latest pending request', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two pulls are in flight', ['src.next() #0', 'src.next() #1']);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the source', ['src.return() #0', 'ret resolved {"done":true}']);

  src.yield(1, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the later value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('the later pending request is retired', ['r1 resolved {"done":true}']);

  src.yield(0, 'v1');
  await flushMicrotasks();
  t.expectLog('predicate runs for the earlier value', ['pred("v1") #1']);

  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('the earlier request still receives its value', [
    'r0 resolved {"value":"v1","done":false}',
  ]);
}]);

// Once a source error has closed the helper, a later in-flight value that drops
// cannot be replaced. The already-vended trailing request resolves done.
tests.push(['filter: after source error, a later drop settles the trailing request done', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two pulls are in flight', ['src.next() #0', 'src.next() #1']);

  src.throw(0, new Error('source reject 0'));
  await flushMicrotasks();
  t.expectLog('source error rejects the dependent request', ['r0 rejected source reject 0']);

  src.yield(1, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the later value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('the trailing request settles done without a replacement pull', [
    'r1 resolved {"done":true}',
  ]);
}]);

// A filtered-out out-of-order value still consumes one in-flight source slot.
// If the source is still open, the helper must immediately pull a replacement.
// But an error from that replacement cannot be assigned to a result request
// until earlier filtering decisions are known: an earlier drop could shift the
// replacement error forward to the earlier request.
tests.push(['filter: out-of-order replacement error waits behind earlier filtering', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two pulls are in flight', ['src.next() #0', 'src.next() #1']);

  src.throwNext(new Error('source throw 2'));

  src.yield(1, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the later value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('replacement pull errors but waits behind the earlier request', [
    'src.next() #2 (throws)',
  ]);

  src.yield(0, 'v1');
  await flushMicrotasks();
  t.expectLog('predicate runs for the earlier value', ['pred("v1") #1']);

  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('the earlier request settles before the replacement error is observed', [
    'r0 resolved {"value":"v1","done":false}',
    'r1 rejected source throw 2',
  ]);
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

tests.push(['filter: synchronous predicate throw closes the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const f = filter(src.iterator, () => { throw new Error('predicate throw 0'); });

  const r0 = f.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('sync predicate throw -> close source, reject', [
    'src.return() #0',
    'r0 rejected predicate throw 0',
  ]);

  const r1 = f.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// When a predicate error closes the source via it.return(), the rejection must
// not be surfaced to the consumer until that it.return() result settles. Per the
// async-iteration model, closing the source is part of finishing, and it has to
// complete before the error is observed — even though the close result itself is
// swallowed. This is the simplest case: a single pull, no concurrency. The
// controlled helpers settle .return() synchronously, so we hand-roll a source
// whose .return() returns a promise the test settles on demand.
tests.push(['filter: predicate error waits for it.return() to settle before rejecting', async function (t) {
  let nextId = 0;
  const pulls = [];
  const returnDeferred = Promise.withResolvers();
  const source = {
    next() {
      const i = nextId++;
      t.log(`src.next() #${i}`);
      const d = Promise.withResolvers();
      pulls[i] = d;
      return d.promise;
    },
    return() {
      t.log('src.return() #0');
      return returnDeferred.promise; // deliberately not settled yet
    },
    [Symbol.asyncIterator]() { return this; },
  };
  const f = filter(source, () => { throw new Error('boom'); });

  const r0 = f.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  pulls[0].resolve({ value: 1, done: false });
  await flushMicrotasks();
  // The predicate throws, so the source is closed — but because it.return() has
  // not settled, the rejection is withheld. Only src.return() shows up here.
  t.expectLog('predicate error closes the source but withholds the rejection', [
    'src.return() #0',
  ]);

  // Now let it.return() settle; the rejection is finally surfaced.
  returnDeferred.resolve({ value: undefined, done: true });
  await flushMicrotasks();
  t.expectLog('rejection surfaces only after it.return() settles', [
    'r0 rejected boom',
  ]);
}]);

// Withholding the predicate-error rejection until it.return() settles must not
// hold up the *other* calls. Once the error reaches the head of the queue its
// recipient is fixed (a head error cannot be dropped, so it cannot shift onto an
// earlier call), so the values behind it can be delivered to the later calls right
// away, without waiting for the pending close. Here pull #2's value is kept behind
// the still-pending head, pull #1's predicate errors (closing the source via a
// pending it.return()), and pull #0 is then dropped: that exposes the error at the
// head, so pull #2's value flows to r1 and the now-surplus r2 settles done — both
// while it.return() is still pending. Only r0, the error's recipient, waits.
tests.push(['filter: a predicate-error close does not block later calls behind the held error', async function (t) {
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

  // Pull #2 yields; its predicate passes -> a kept value buffered behind the
  // still-pending earlier positions.
  src.yield(2, 30);
  await flushMicrotasks();
  t.expectLog('the third value runs the predicate', ['pred(30) #0']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('the kept value is buffered behind the pending head', []);

  // Pull #1 yields; its predicate errors, closing the source via a pending
  // it.return(). The error sits behind the still-pending pull #0, so nothing
  // settles yet — in particular r2 is not done, because pull #0 could still be a
  // value that would feed it.
  src.holdReturn();
  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('the second value runs the predicate', ['pred(20) #1']);

  pred.reject(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the predicate error closes the source; nothing settles yet', ['src.return() #0']);

  // Pull #0 yields and is dropped, exposing the error at the head. Its recipient
  // (r0) is now fixed and it cannot be dropped, so pull #2's value flows to r1 and
  // the now-surplus r2 settles done — without waiting for the pending it.return().
  src.yield(0, 10);
  await flushMicrotasks();
  t.expectLog('the first value runs the predicate', ['pred(10) #2']);

  pred.resolve(2, false);
  await flushMicrotasks();
  t.expectLog('the value behind the error is delivered and the surplus call is done', [
    'r1 resolved {"value":30,"done":false}',
    'r2 resolved {"done":true}',
  ]);

  // Only when it.return() settles does the error finally surface to r0.
  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('the held error surfaces once the close settles', ['r0 rejected boom']);
}]);

// The same effect when the erroring value is already at the head of the queue
// when its predicate errors. A value buffered behind it (pull #1's, kept) is
// delivered to r1 the moment the head predicate errors and closes the source,
// without waiting for the pending it.return(); only r0 — the error's recipient —
// waits for the close.
tests.push(['filter: a head predicate-error close delivers the value behind it immediately', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  // Pull #1 yields; its predicate passes -> a kept value buffered behind the
  // still-pending head (pull #0).
  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('the second value runs the predicate', ['pred(20) #0']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('the kept value is buffered behind the pending head', []);

  // Pull #0 yields; its predicate errors at the head of the queue, closing the
  // source via a pending it.return(). The error's recipient (r0) is fixed, so the
  // value behind it is delivered to r1 immediately — not blocked on the close.
  src.holdReturn();
  src.yield(0, 10);
  await flushMicrotasks();
  t.expectLog('the head value runs the predicate', ['pred(10) #1']);

  pred.reject(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the close is called and the value behind the error is delivered', [
    'src.return() #0',
    'r1 resolved {"value":20,"done":false}',
  ]);

  // Only when it.return() settles does the error surface to r0.
  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('the held error surfaces once the close settles', ['r0 rejected boom']);
}]);

// A `done` is always a terminal wall, even after the result has already finished by
// some other terminal event: a `done` arriving from a still-in-flight earlier pull
// discards its position and every later one, including a later position that already
// settled with a value or an error. The three tests below land a `done` after each of
// the other three terminal events.

// Predicate error: it closes the source via it.return(), and *this* upstream reacts
// to return() by settling the still-outstanding earlier pull #0 with { done: true }.
// That done lands after the predicate error has finished the result, but it is still a
// wall: it discards the later erroring position, so the predicate error is swallowed
// and never surfaces. Both calls drain to done.
tests.push(['filter: a return()-triggered upstream done walls away the predicate error', async function (t) {
  // Hand-rolled so return() can settle the outstanding pull #0 with done.
  let nextId = 0;
  const pulls = [];
  const src = {
    next() {
      const i = nextId++;
      t.log(`src.next() #${i}`);
      const d = Promise.withResolvers();
      pulls[i] = d;
      return d.promise;
    },
    return() {
      t.log('src.return() #0');
      // The upstream treats return() as a cue to finish the outstanding pull #0.
      pulls[0].resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() { return this; },
  };
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  // Pull #1 yields; pull #0 is still pending.
  pulls[1].resolve({ value: 2, done: false });
  await flushMicrotasks();
  t.expectLog('the second value runs the predicate', ['pred(2) #0']);

  // The predicate throws. it.return() settles pull #0 with done, and that late done
  // walls away the later erroring position: the error is swallowed and both calls
  // drain to done.
  pred.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the late done walls away the error; both calls drain to done', [
    'src.return() #0',
    'r0 resolved {"done":true}',
    'r1 resolved {"done":true}',
  ]);
}]);

// A source *error* does NOT close the source. The later pull rejects (source error);
// then the earlier pull #0 resolves done. That done ends the sequence at #0, making
// the error at #1 a speculative over-pull beyond the end: it is walled away, and both
// calls resolve done. (Same family as "a source done retroactively caps a later
// already-observed error".)
tests.push(['filter: a source done after a source error still caps the over-pulled error', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  // Source error at the later pull; it sits behind the still-pending pull #0. A
  // source error does not close the source.
  src.throw(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the source error waits behind the pending head', []);

  // The earlier pull then resolves done. The source was never closed, so this done is
  // a real wall: it ends the sequence at #0 and caps the over-pulled error at #1.
  src.finish(0);
  await flushMicrotasks();
  t.expectLog('the done caps the over-pulled error -> both calls done', [
    'r0 resolved {"done":true}',
    'r1 resolved {"done":true}',
  ]);
}]);

// return(): the buried outcome here is a *value*. After return() closes the source,
// pull #1 yields a value that passes; the still-pending earlier pull #0 then resolves
// done. That late done is still a wall: it discards pull #1's already-determined value
// along with its own slot, so both calls drain to done and the value never surfaces.
tests.push(['filter: a late source done after return() walls away an already-requested value', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the source', ['src.return() #0', 'ret resolved {"done":true}']);

  // Pull #1 yields a passing value, buffered behind the still-pending pull #0.
  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('the second value runs the predicate', ['pred(20) #0']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('the value is buffered behind the pending head', []);

  // The earlier pull resolves done. This late done walls away pull #1's value.
  src.finish(0);
  await flushMicrotasks();
  t.expectLog('the late done walls away the buffered value; both calls drain to done', [
    'r0 resolved {"done":true}',
    'r1 resolved {"done":true}',
  ]);
}]);

// Regression for the microtask ordering of a *synchronous* predicate throw.
// When a drop both unblocks a buffered value and issues a replacement pull, and
// that replacement's value makes the predicate throw synchronously, the throw
// must be handled one hop later — exactly like an async rejection — not inline.
// Otherwise the source close (and the rejection it leads to) jumps ahead of the
// value the same step unblocked. This needs a synchronous source cascade, so it
// uses a hand-rolled sync source/predicate rather than the controlled helpers:
// pull #0 is async (so a later value can buffer behind it) while pulls #1/#2
// return synchronously, and the predicate throws synchronously on 'B'.
tests.push(['filter: a synchronous predicate throw on a replacement defers its close behind an unblocked value', async function (t) {
  let nextId = 0, retId = 0;
  const pending = [];
  const source = {
    next() {
      const i = nextId++;
      t.log(`src.next() #${i}`);
      if (i === 0) { const d = Promise.withResolvers(); pending[i] = d; return d.promise; }
      if (i === 1) return { value: 'A', done: false };
      if (i === 2) return { value: 'B', done: false };
      return { value: undefined, done: true };
    },
    return() { t.log(`src.return() #${retId++}`); return Promise.resolve({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() { return this; },
  };
  const pred = (x) => {
    t.log(`pred(${x})`);
    if (x === 'B') throw new Error('boom'); // synchronous throw on the replacement value
    return x === 'A';                       // 'A' passes; pull #0's value is dropped
  };
  const f = filter(source, pred);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  // Pull #0 stays pending; pull #1 synchronously yields 'A', which passes and is
  // buffered behind the still-pending head.
  t.expectLog('the second value is buffered behind the pending first pull', [
    'src.next() #0',
    'src.next() #1',
    'pred(A)',
  ]);

  // Pull #0 resolves with a value the predicate drops. That frees the buffered
  // 'A' for r0 and issues replacement pull #2, whose 'B' throws synchronously.
  // The throw is deferred, so 'A' reaches r0 before the close and the rejection.
  pending[0].resolve({ value: 'drop', done: false });
  await flushMicrotasks();
  t.expectLog('unblocked value delivered before the deferred predicate-error close', [
    'pred(drop)',
    'src.next() #2',
    'pred(B)',
    'r0 resolved {"value":"A","done":false}',
    'src.return() #0',
    'r1 rejected boom',
  ]);
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

tests.push(['filter: return() after source done does not close the source', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two pulls are in flight', ['src.next() #0', 'src.next() #1']);

  src.finish(0);
  await flushMicrotasks();
  t.expectLog('source done settles outstanding calls', [
    'r0 resolved {"done":true}',
    'r1 resolved {"done":true}',
  ]);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() after source done does not call source.return()', [
    'ret resolved {"done":true}',
  ]);
}]);

tests.push(['filter: return() after source error does not close the source', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two pulls are in flight', ['src.next() #0', 'src.next() #1']);

  src.throw(0, new Error('source reject 0'));
  await flushMicrotasks();
  t.expectLog('source error rejects its dependent call', ['r0 rejected source reject 0']);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() after source error does not call source.return()', [
    'ret resolved {"done":true}',
  ]);

  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('already-requested value still runs the predicate', ['pred(20) #0']);

  pred.resolve(0, true);
  await flushMicrotasks();
  t.expectLog('already-requested value still reaches its call', [
    'r1 resolved {"value":20,"done":false}',
  ]);
}]);

// Regression from the bounded-exhaustive suite: if an underlying error is
// sitting behind an earlier predicate that later drops, the error shifts forward
// to the earlier call, and any already-vended trailing call that would need a
// new pull must settle done rather than hang.
tests.push(['filter: underlying error behind an earlier drop drains trailing calls', async function (t) {
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
  t.expectLog('first predicate is pending', ['pred(1) #0']);

  // The underlying error is in the second retained slot, so it cannot surface
  // until the first slot is resolved.
  src.throw(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('underlying error waits behind the earlier predicate', []);

  // Dropping the first slot makes the underlying error reject r0. With the
  // source terminal and no replacement pull possible, r1 resolves done.
  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('error shifts forward and the trailing call drains', [
    'r0 rejected boom',
    'r1 resolved {"done":true}',
  ]);
}]);

// Same shape, but the terminal event is a predicate error rather than an
// underlying error. The erroring value still occupies a slot, so when an earlier
// value drops the error moves forward and trailing unserviceable calls drain.
tests.push(['filter: predicate error behind an earlier drop drains trailing calls', async function (t) {
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
  t.expectLog('both predicates are pending', ['pred(1) #0', 'pred(2) #1']);

  pred.reject(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('later predicate error closes but waits behind the first predicate', [
    'src.return() #0',
  ]);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('error shifts forward and the trailing call drains', [
    'r0 rejected boom',
    'r1 resolved {"done":true}',
  ]);
}]);

// --- Source done / error caps interacting with filtered-out values ---

// A done is terminal for every later source position, even one that was
// eagerly pulled and already errored before the done arrived. The speculative
// error at slot #2 must be discarded — not resurrected to satisfy the earlier
// pending call when its own value is dropped.
tests.push(['filter: a source done retroactively caps a later already-observed error', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('first two pulls are in flight', ['src.next() #0', 'src.next() #1']);

  // Arm the third pull to throw synchronously, then vend the third call so that
  // pull #2 (and only pull #2) throws.
  src.throwNext(new Error('source throw 2'));
  const r2 = f.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('third pull throws synchronously and is stored, settling nothing', [
    'src.next() #2 (throws)',
  ]);

  // Done at slot #1 (slot #0 still pending). The done caps slot #2, so the
  // stored error is suppressed: r1 (its own position) and r2 (past the done)
  // both settle done.
  src.finish(1);
  await flushMicrotasks();
  t.expectLog('done caps the later error -> r1 and r2 done', [
    'r1 resolved {"done":true}',
    'r2 resolved {"done":true}',
  ]);

  // The still-pending earlier value arrives and is dropped. With the source
  // already done there is no replacement pull and no error to expose, so r0 is
  // simply done.
  src.yield(0, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the earlier value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('dropped value followed by the capped done -> r0 done', [
    'r0 resolved {"done":true}',
  ]);
}]);

// Once a source error has already rejected its own call (r0), a later
// out-of-order value that drops retires the *latest* pending call (r2) done,
// while the middle call (r1) stays pending behind its own in-flight slot.
tests.push(['filter: a consumed source error no longer blocks a later done', async function (t) {
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

  src.throw(0, new Error('source reject 0'));
  await flushMicrotasks();
  t.expectLog('the error rejects its dependent call', ['r0 rejected source reject 0']);

  // Slot #2 yields out of order while slot #1 is still pending.
  src.yield(2, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the out-of-order value', ['pred("v0") #0']);

  // The drop cannot be replaced (source is terminal), and slot #2 is past the
  // error cap, so the latest call retires done. r1 is still owed slot #1.
  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('the latest pending call retires done', ['r2 resolved {"done":true}']);

  await flushMicrotasks();
  t.expectLog('the middle call stays pending', []);
}]);

// A known error sits one slot behind the head. Dropping the head exposes the
// error as the next retained outcome, so it must reject the earliest pending
// call before any later done is emitted.
tests.push(['filter: a filtered-out value before a known error compacts the error first', async function (t) {
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

  // Error at slot #1 cannot surface while slot #0 is unresolved.
  src.throw(1, new Error('source reject 1'));
  await flushMicrotasks();
  t.expectLog('error waits behind the unresolved head', []);

  src.yield(0, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the head value', ['pred("v0") #0']);

  // Dropping the head exposes the slot #1 error as the next outcome: it rejects
  // r0. Slot #2 is still in flight and is owed to r1, so only r2 (beyond it,
  // with no new pulls coming) retires done; r1 stays pending.
  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('error compacts forward to r0; the latest call retires done', [
    'r0 rejected source reject 1',
    'r2 resolved {"done":true}',
  ]);

  await flushMicrotasks();
  t.expectLog('the middle call stays pending behind its in-flight slot', []);
}]);

// An error cap sits at slot #1 while slot #0 is still pending. A later
// out-of-order value (slot #2) drops; because slot #2 is past the cap and
// cannot be replaced, the latest call retires done while the earlier two wait.
tests.push(['filter: a later filtered-out value after a pending error retires the latest done', async function (t) {
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

  src.throw(1, new Error('source reject 1'));
  await flushMicrotasks();
  t.expectLog('error at slot #1 waits behind the pending head', []);

  // Slot #2 yields while slot #0 is still pending.
  src.yield(2, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the out-of-order value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('the latest call is beyond the cap and retires done', [
    'r2 resolved {"done":true}',
  ]);

  await flushMicrotasks();
  t.expectLog('the earlier two calls stay pending', []);
}]);

// The latest in-flight slot (#2) is a known error cap. An earlier value
// (slot #0) drops while slot #1 is still pending. The latest call can be done
// regardless of how slot #1 compacts, because at most two outcomes remain for
// three calls.
tests.push(['filter: an earlier filtered-out value before a later pending error retires the latest done', async function (t) {
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

  src.throw(2, new Error('source reject 2'));
  await flushMicrotasks();
  t.expectLog('error at the latest slot waits behind the earlier slots', []);

  // Slot #0 yields while slot #1 is still pending.
  src.yield(0, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the head value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('only the latest call retires done', ['r2 resolved {"done":true}']);

  await flushMicrotasks();
  t.expectLog('the earlier two calls stay pending', []);
}]);

// A replacement pull (triggered by a drop) throws, but the error's final
// filtered position is unknown while an earlier slot is unresolved. When that
// earlier value also drops, the error compacts forward to the earliest call and
// the tail call drains done — the rejection observed before the done.
tests.push(['filter: a compacted source error rejects before the tail done', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  // Arm the replacement pull to throw, then drop slot #1's value so the helper
  // issues that replacement pull (#2), which throws.
  src.throwNext(new Error('source throw 2'));
  src.yield(1, 'v0');
  await flushMicrotasks();
  t.expectLog('predicate runs for the later value', ['pred("v0") #0']);

  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('replacement pull throws but waits: slot #0 is unresolved', [
    'src.next() #2 (throws)',
  ]);

  src.yield(0, 'v1');
  await flushMicrotasks();
  t.expectLog('predicate runs for the earlier value', ['pred("v1") #1']);

  // The earlier value also drops, so the compacted error is now the sole
  // surviving outcome: it rejects r0, and r1 drains done after it.
  pred.resolve(1, false);
  await flushMicrotasks();
  t.expectLog('compacted error rejects r0 before the tail done', [
    'r0 rejected source throw 2',
    'r1 resolved {"done":true}',
  ]);
}]);

// Directly targets the worry that #issuePull's *synchronous* error branch does
// not call #processQueue itself: if a buried synchronous source error needs no
// subsequent next() to surface, then the only thing that drives the queue
// forward is the earlier blocking position settling on its own. Here pull #1's
// value is dropped, issuing replacement pull #2 which throws synchronously while
// pull #0 is still pending — so the error sits buried, and NO further next() is
// ever called. When pull #0 finally yields a passing value, r0 takes it and the
// buried error must then reach r1. If the synchronous branch truly stranded the
// error, r1 would stay pending forever and the final assertion would fail.
tests.push(['filter: a buried synchronous source error surfaces with no subsequent next()', async function (t) {
  const src = controlledSource(t.log, 'src');
  const pred = controlledFn(t.log, 'pred');
  const f = filter(src.iterator, pred.fn);

  const r0 = f.next();
  const r1 = f.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  // Arm the replacement pull to throw synchronously.
  src.throwNext(new Error('replacement throw'));

  // Pull #1 yields out of order while pull #0 is still pending; its predicate runs.
  src.yield(1, 20);
  await flushMicrotasks();
  t.expectLog('the later value runs the predicate', ['pred(20) #0']);

  // Dropping it issues replacement pull #2, which throws synchronously. The error
  // is buried behind the still-pending pull #0, so nothing settles — and from here
  // on no further next() is ever called.
  pred.resolve(0, false);
  await flushMicrotasks();
  t.expectLog('replacement throws but the error is buried behind the pending head', [
    'src.next() #2 (throws)',
  ]);

  // The earlier pull finally yields a passing value: r0 takes it, then the buried
  // error must reach r1 — driven only by this settlement, not by any new next().
  src.yield(0, 10);
  await flushMicrotasks();
  t.expectLog('the earlier value runs the predicate', ['pred(10) #1']);

  pred.resolve(1, true);
  await flushMicrotasks();
  t.expectLog('earlier value delivered, then the buried error reaches r1', [
    'r0 resolved {"value":10,"done":false}',
    'r1 rejected replacement throw',
  ]);
}]);

runTests(tests, xfailed);

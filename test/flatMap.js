import { flatMap } from '../flatMap.ts';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';

let tests = [];
let xfailed = [];

// What makes flatMap distinctive among map/filter/flatMap:
//
//   * One consumer next() is not 1:1 with an underlying pull. Each underlying
//     value is fed to the mapper to produce an *inner* (async) iterator, and the
//     flattened stream is the concatenation of every inner iterator's values.
//     The i-th value of that concatenation feeds the i-th consumer call.
//
//   * Concurrent next() calls do NOT each pull the underlying. While the helper
//     is still resolving an underlying value into an inner iterator ("reading
//     underlying"), further next() calls merely raise the demand count. When the
//     inner iterator finally exists it is pulled `demand` times at once. So N
//     concurrent calls cause a SINGLE underlying pull and a SINGLE mapper call,
//     then N concurrent inner pulls.
//
//   * An inner iterator's `done` is NOT terminal for the stream: it just means
//     "this inner iterator is exhausted, move on". The still-unsatisfied demand
//     that was aimed at it is redirected to a fresh underlying pull (carrying the
//     count), which produces the next inner iterator. Only the UNDERLYING running
//     out (`done`) ends the stream.
//
//   * Because the concatenation order is fixed, a later value can never be
//     delivered before an earlier position's fate is known — exactly like filter.
//     When an inner iterator reports `done` while some of its own earlier pulls
//     are still in flight, those pulls stay queued ahead of the next iterator's
//     values so delivery order is preserved.
//
// Throughout, the mapper is driven by a controlledFn whose call we settle with an
// inner controlledSource's `.iterator`; that lets us control both *when* the
// mapper resolves and *which* inner iterator it yields, and independently drive
// each inner iterator's pulls.

// The simple sequential case. A single inner iterator yields two values (one per
// consumer call), then reports done — which is NOT the end of the stream but a
// cue to pull the underlying again. The underlying is then exhausted, and only
// that terminal underlying done propagates as a consumer `done`. Also pins
// laziness: an inner iterator is only pulled when there is demand for it.
tests.push(['flatMap: sequential across a single inner iterator, then a re-pull, then done', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying once', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the underlying value is handed to the mapper', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  // The mapper produced inner iterator A; demand was 1, so A is pulled once.
  t.expectLog('the inner iterator is pulled to satisfy the one outstanding call', ['A.next() #0']);

  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the inner value is delivered to the first call', [
    'r0 resolved {"value":"a0","done":false}',
  ]);

  // A second consumer call pulls the *same* active inner iterator (not the
  // underlying) — and only now, on demand.
  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a later call pulls the same inner iterator again', ['A.next() #1']);

  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('the second inner value is delivered', [
    'r1 resolved {"value":"a1","done":false}',
  ]);

  // A third call pulls A again; A then reports done.
  const r2 = fm.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('a third call pulls the inner iterator once more', ['A.next() #2']);

  A.finish(2);
  await flushMicrotasks();
  // Inner done is not the end: the outstanding demand (1) is redirected to a
  // fresh underlying pull.
  t.expectLog('inner done redirects demand to a new underlying pull', ['src.next() #1']);

  src.finish(1);
  await flushMicrotasks();
  // The underlying is exhausted — THIS done is terminal and reaches the consumer.
  t.expectLog('underlying done is terminal and propagates', ['r2 resolved {"done":true}']);
}]);

// An empty inner iterator (immediately done) yields no values, so the single
// outstanding call cannot be satisfied from it: the helper must pull the
// underlying again to find the next inner iterator. The consumer call only ever
// sees the value from the *second* iterator.
tests.push(['flatMap: an empty inner iterator triggers another underlying pull', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('mapper invoked for the first underlying value', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('inner iterator A is pulled once', ['A.next() #0']);

  // A is empty: it reports done before yielding anything.
  A.finish(0);
  await flushMicrotasks();
  t.expectLog('the empty inner iterator forces another underlying pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('mapper invoked for the second underlying value', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('inner iterator B is pulled once', ['B.next() #0']);

  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('the value from the second iterator satisfies the call', [
    'r0 resolved {"value":"b0","done":false}',
  ]);
}]);

// Demand coalescing + fan-out. Three concurrent next() calls cause a SINGLE
// underlying pull and a SINGLE mapper invocation; the resulting inner iterator is
// then pulled three times at once. With the inner pulls settled in order, the
// three values are delivered in call order.
tests.push(['flatMap: concurrent calls coalesce into one underlying pull and fan out to one inner iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  const r2 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  // Three concurrent calls, but only ONE underlying pull: the later two only
  // raised the demand count while the first was still being resolved.
  t.expectLog('three concurrent calls cause a single underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  // ONE mapper call for the one underlying value.
  t.expectLog('a single mapper invocation', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  // The accumulated demand (3) fans out into three concurrent inner pulls.
  t.expectLog('the inner iterator is pulled once per outstanding call', [
    'A.next() #0',
    'A.next() #1',
    'A.next() #2',
  ]);

  A.yield(0, 'a0');
  A.yield(1, 'a1');
  A.yield(2, 'a2');
  await flushMicrotasks();
  t.expectLog('the three inner values are delivered in call order', [
    'r0 resolved {"value":"a0","done":false}',
    'r1 resolved {"value":"a1","done":false}',
    'r2 resolved {"value":"a2","done":false}',
  ]);
}]);

// Out-of-order settlement within a single inner iterator is reordered before
// delivery. Two concurrent inner pulls are in flight; the LATER one settles
// first, but it cannot be delivered ahead of the earlier (still-pending) one —
// each consumer call receives its own in-call-order value.
tests.push(['flatMap: out-of-order inner settlement is delivered in order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('mapper invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('two concurrent inner pulls', ['A.next() #0', 'A.next() #1']);

  // The second inner pull settles first; it must wait for the first.
  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('a later inner value cannot settle ahead of an earlier one', []);

  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('once the earlier value arrives, both settle in call order', [
    'r0 resolved {"value":"a0","done":false}',
    'r1 resolved {"value":"a1","done":false}',
  ]);
}]);

// The scenario from the spec sketch. Four pulls; the first inner iterator (A)
// leaves two pulls in flight, then reports done — which immediately triggers
// another underlying pull whose mapper yields a second iterator (B), pulled twice.
// A's two still-in-flight pulls remain queued AHEAD of B's values, so even though
// a B value settles first, delivery order is a0, a1, b0, b1.
tests.push(['flatMap: inner done with earlier pulls still in flight queues them ahead of the next iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  const r2 = fm.next();
  const r3 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  track(t.log, 'r3', r3);
  await flushMicrotasks();
  t.expectLog('four concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('one mapper invocation', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 4 fans out into four inner pulls', [
    'A.next() #0',
    'A.next() #1',
    'A.next() #2',
    'A.next() #3',
  ]);

  // A's first two pulls (#0, #1) stay in flight; pull #2 reports done. That
  // discards the tail (#2, #3) and redirects the freed demand (2) to a new
  // underlying pull. A's #0/#1 are not lost — they stay queued ahead.
  A.finish(2);
  await flushMicrotasks();
  t.expectLog('inner done redirects the freed demand to another underlying pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the second underlying value is mapped', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  // The redirected demand (2) fans out across B.
  t.expectLog('the second inner iterator is pulled twice', ['B.next() #0', 'B.next() #1']);

  // B's first value settles, but A's values are still queued ahead of it.
  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('a later iterator value waits behind the earlier iterator', []);

  // A's first value arrives -> r0.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the earliest queued value is delivered', [
    'r0 resolved {"value":"a0","done":false}',
  ]);

  // A's second value arrives -> r1, which drains A and exposes B's buffered
  // b0 -> r2, all in one step.
  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('draining the first iterator lets the buffered later value through', [
    'r1 resolved {"value":"a1","done":false}',
    'r2 resolved {"value":"b0","done":false}',
  ]);

  B.yield(1, 'b1');
  await flushMicrotasks();
  t.expectLog('the last value is delivered', [
    'r3 resolved {"value":"b1","done":false}',
  ]);
}]);

// A terminal underlying done caps the trailing calls that can never be served,
// while an earlier inner value that is still in flight is NOT lost. Pull #1 of
// inner A reports done with pull #0 still pending, so A's #0 stays queued and the
// freed demand (2) goes to a fresh underlying pull; that underlying is then
// exhausted, so the two redirected calls settle done — but the call tied to A's
// still-pending #0 stays open and ultimately receives its value.
tests.push(['flatMap: a terminal underlying done caps trailing calls but keeps an in-flight inner value', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  const r2 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('three concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('one mapper invocation', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 3 fans out across A', ['A.next() #0', 'A.next() #1', 'A.next() #2']);

  // A's pull #0 stays pending; pull #1 reports done. The tail (#1, #2) is freed
  // (demand 2) and redirected; A's #0 remains queued ahead.
  A.finish(1);
  await flushMicrotasks();
  t.expectLog('the freed demand is redirected to another underlying pull', ['src.next() #1']);

  // The underlying is now exhausted. This terminal done caps the two redirected
  // calls (the last two in call order); the call still tied to A's pending #0 is
  // left open.
  src.finish(1);
  await flushMicrotasks();
  t.expectLog('the terminal done settles only the un-serviceable trailing calls', [
    'r1 resolved {"done":true}',
    'r2 resolved {"done":true}',
  ]);

  // A's still-in-flight #0 finally yields: its value is not lost.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the earlier in-flight inner value still reaches its call', [
    'r0 resolved {"value":"a0","done":false}',
  ]);
}]);

// An inner iterator that reports done at its very first pull, with the full demand
// in flight, redirects ALL of it to a fresh underlying pull (no values queued
// ahead). A later settlement of one of the now-discarded inner pulls is harmless.
tests.push(['flatMap: a first-pull inner done redirects the whole demand; a late discarded pull is ignored', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('one mapper invocation', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  // A reports done at pull #0 while pull #1 is still in flight. With nothing
  // delivered, the entire demand (2) is redirected; A's #1 is discarded.
  A.finish(0);
  await flushMicrotasks();
  t.expectLog('the whole demand is redirected to a new underlying pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('mapper invoked for the second underlying value', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('the second inner iterator absorbs the redirected demand', ['B.next() #0', 'B.next() #1']);

  B.yield(0, 'b0');
  B.yield(1, 'b1');
  await flushMicrotasks();
  t.expectLog('both calls are satisfied from the second iterator', [
    'r0 resolved {"value":"b0","done":false}',
    'r1 resolved {"value":"b1","done":false}',
  ]);

  // The discarded inner pull (A's #1) settles late; it has no consumer effect.
  A.yield(1, 'a1-late');
  await flushMicrotasks();
  t.expectLog('a late settlement of a discarded inner pull is ignored', []);
}]);

// A deeper version of the queued-ahead case: three inner iterators each leave one
// earlier pull in flight when they report done, building a queue [A, B] ahead of
// the active iterator C. Everything settles out of order, yet the final delivery
// follows the concatenation order a0, b0, c0, c1.
tests.push(['flatMap: a chain of inner-done boundaries preserves cross-iterator order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  const r2 = fm.next();
  const r3 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  track(t.log, 'r3', r3);
  await flushMicrotasks();
  t.expectLog('four concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('mapper invoked for the first value', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 4 fans out across A', [
    'A.next() #0',
    'A.next() #1',
    'A.next() #2',
    'A.next() #3',
  ]);

  // A keeps #0 in flight and reports done at #1: A's #0 is queued; demand 3 is
  // redirected.
  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A done redirects demand 3', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('mapper invoked for the second value', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('demand 3 fans out across B', ['B.next() #0', 'B.next() #1', 'B.next() #2']);

  // B keeps #0 in flight and reports done at #1: queue is now [A, B]; demand 2
  // is redirected.
  B.finish(1);
  await flushMicrotasks();
  t.expectLog('B done redirects demand 2', ['src.next() #2']);

  src.yield(2, 3);
  await flushMicrotasks();
  t.expectLog('mapper invoked for the third value', ['m(3) #2']);

  const C = controlledSource(t.log, 'C');
  m.resolve(2, C.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across C', ['C.next() #0', 'C.next() #1']);

  // Settle everything out of order: the active iterator first, then B, then A.
  C.yield(0, 'c0');
  C.yield(1, 'c1');
  await flushMicrotasks();
  t.expectLog('the active iterator values wait behind the queued iterators', []);

  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('B still waits behind A', []);

  // A's value arrives and the whole queue drains in concatenation order.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the entire queue drains in order once the head arrives', [
    'r0 resolved {"value":"a0","done":false}',
    'r1 resolved {"value":"b0","done":false}',
    'r2 resolved {"value":"c0","done":false}',
    'r3 resolved {"value":"c1","done":false}',
  ]);
}]);

// An immediately-exhausted underlying: the very first pull reports done, so the
// stream is empty. The outstanding call settles done, and any later call is done
// too.
tests.push(['flatMap: an empty underlying is done immediately', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.finish(0);
  await flushMicrotasks();
  // The mapper is never invoked (no underlying value), and no source.return()
  // happens on clean exhaustion.
  t.expectLog('an exhausted underlying settles the call done', ['r0 resolved {"done":true}']);

  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a later call is done as well', ['r1 resolved {"done":true}']);
}]);

// next() always returns a promise (never a bare result object), even once the
// helper has finished.
tests.push(['flatMap: next() returns a promise', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  t.check('active next() returns a promise', r0 instanceof Promise, true);
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.finish(0);
  await flushMicrotasks();
  t.expectLog('the call settles done', ['r0 resolved {"done":true}']);

  const rDone = fm.next();
  t.check('a settled next() still returns a promise', rDone instanceof Promise, true);
  track(t.log, 'rDone', rDone);
  await flushMicrotasks();
  t.expectLog('the settled call resolves done', ['rDone resolved {"done":true}']);
}]);

// --- Errors -----------------------------------------------------------------
//
// The error model mirrors map/filter:
//   * An error *from* the underlying iterator (a rejected `.next()`) is surfaced
//     to the dependent call but does NOT close the underlying — there is never a
//     `src.return()` after observing an underlying error.
//   * An error *in* the mapper, or *from* an inner (result) iterator, DOES close
//     the underlying via `src.return()`; per the async-iteration model the close
//     must settle before the error is surfaced to the consumer (though the close
//     result itself is swallowed).
// A rejected inner `.next()` exhausts that inner iterator, so we never call
// `.return()` on the erroring inner iterator itself — only on the underlying.

// An error from the underlying `.next()` is surfaced without closing the source.
tests.push(['flatMap: an error from the underlying iterator does not close it', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.throw(0, new Error('boom'));
  await flushMicrotasks();
  // No `src.return()`: the underlying error is surfaced without closing.
  t.expectLog('underlying error rejects, source left open', ['r0 rejected boom']);

  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// A synchronous throw from the mapper closes the underlying (like a map/filter
// predicate throw) and the result rejects.
tests.push(['flatMap: a synchronous throw from the mapper closes the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const fm = flatMap(src.iterator, () => { throw new Error('boom'); });

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper throw closes the source, then rejects', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// An asynchronous mapper rejection behaves the same as a synchronous throw: it
// closes the underlying and the result rejects.
tests.push(['flatMap: an async mapper rejection closes the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  m.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the mapper rejection closes the source, then rejects', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// An error from an inner (result) iterator's `.next()` closes the UNDERLYING
// (but not the erroring inner iterator, which a rejected next has exhausted), and
// the result rejects.
tests.push(['flatMap: an error from an inner iterator closes the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  // The inner iterator's pull rejects. That closes the underlying (only — not the
  // already-exhausted inner iterator), then the rejection surfaces.
  A.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the inner error closes the underlying, then rejects', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// When a mapper error closes the underlying via `src.return()`, the rejection
// must not surface until that `src.return()` settles. Hand-rolled so `.return()`
// returns a promise the test settles on demand (the controlled source settles
// `.return()` synchronously).
tests.push(['flatMap: a mapper error waits for underlying.return() to settle before rejecting', async function (t) {
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
  const fm = flatMap(source, () => { throw new Error('boom'); });

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  pulls[0].resolve({ value: 1, done: false });
  await flushMicrotasks();
  // The mapper throws, so the underlying is closed — but the rejection is
  // withheld because `src.return()` has not settled.
  t.expectLog('the mapper error closes the source but withholds the rejection', [
    'src.return() #0',
  ]);

  returnDeferred.resolve({ value: undefined, done: true });
  await flushMicrotasks();
  t.expectLog('the rejection surfaces only after the close settles', [
    'r0 rejected boom',
  ]);
}]);

// Values are not lost: a later inner pull errors first (closing the underlying),
// but an earlier in-flight inner value still reaches its call before the error is
// surfaced to the call scanning into it. Mirrors the map/filter invariant.
tests.push(['flatMap: a later inner error does not lose an earlier in-flight inner value', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('two concurrent inner pulls', ['A.next() #0', 'A.next() #1']);

  // The later inner pull (#1) errors first. It closes the underlying, but it sits
  // behind the still-pending pull #0, so nothing is surfaced yet.
  A.throw(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the later inner error closes the source but waits behind the earlier pull', [
    'src.return() #0',
  ]);

  // Pull #0 yields: its value reaches r0 (not lost), then the error reaches r1.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the earlier value is delivered, then the error reaches the later call', [
    'r0 resolved {"value":"a0","done":false}',
    'r1 rejected boom',
  ]);
}]);

// --- return() ---------------------------------------------------------------
//
// return() means "no more demand". It closes whatever is still open — the active
// inner iterator (if any) and the underlying — and resolves to a done result.
// Future next() calls are done. As in map/filter, a source that has already
// finished (clean done) or errored is NOT closed again.
//
// NOTE: the disposition of calls that are *already in flight* on the active inner
// iterator when return() lands is a genuine open design question (the active
// iterator is being closed, so those values arguably cannot be delivered) and is
// deliberately NOT asserted here — see the no-in-flight-call setups below.

// return() before anything has started: nothing was ever pulled, but the
// underlying is still closed (matching map/filter, which call .return()
// unconditionally). No src.next() happens; future calls are done.
tests.push(['flatMap: return() before starting closes the underlying without pulling', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  // No src.next() (nothing was ever pulled), but the underlying is still closed.
  t.expectLog('return() closes the underlying without pulling, then resolves done', [
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a next() after return() is done', ['r0 resolved {"done":true}']);
}]);

// --- return() while reading the underlying (the "less-eager pull" model) -----
//
// When return() lands while a pull from the underlying is in flight (no inner
// iterator yet), we are committed to closing, so we will NOT pull the iterator that
// pull is about to produce. We close the UNDERLYING eagerly (right at return(),
// while the pull is still in flight), but we still wait for the pull and the mapper,
// because they might throw/reject — a stream error that must reach a consumer call.
//
//   * The `requested` units of demand bound to that pull can never receive a value
//     (we won't pull), so the trailing `requested - 1` "surplus" calls are doned
//     {done:true} EAGERLY at return(). The head-most bound call is HELD: it is the
//     position a pull/mapper rejection would be delivered to (queued behind any
//     parked values, like a normal underlying error).
//   * When the in-flight pull/mapper settle:
//       - pull rejects   -> the rejection (the stream's error) goes to the held call.
//       - mapper rejects -> the mapper error goes to the held call (withheld until
//                           the eager underlying close settles).
//       - value+iterable -> invoke the iterable and call .return() on it RIGHT AWAY
//                           (no .next()); the held call dones.
//   * result.return() waits for BOTH the eager underlying .return() AND (if an inner
//     iterator gets produced) the inner .return(), which can be outstanding
//     CONCURRENTLY. (This is intentionally different from the active-iterator return
//     path, which closes inner-then-underlying sequentially.) It resolves done once
//     both settle, or rejects with a CLOSE error (inner taking precedence over the
//     underlying). The stream error from a pull/mapper rejection goes to the held
//     call, never to return()'s promise.

// The base success case: a single outstanding call. The underlying is closed eagerly
// at return(); the produced iterator is closed without being pulled; the held call
// dones; and return() waits for BOTH closes.
tests.push(['flatMap: return() while reading the underlying closes the produced iterator without pulling it', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a pull is in flight', ['src.next() #0']);

  // return() while reading underlying. The underlying is closed EAGERLY (the pull is
  // still in flight); r0 is held in case the pull/mapper rejects.
  src.holdReturn();
  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying is closed eagerly; the call is held', ['src.return() #0']);

  // The pull resolves with a value; the mapper is invoked.
  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the in-flight underlying value is mapped', ['m(1) #0']);

  // The mapper resolves to an iterable: invoke it and call .return() RIGHT AWAY (no
  // .next()). The held call can never get a value now, so it dones.
  const A = controlledSource(t.log, 'A');
  A.holdReturn();
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the produced iterator is closed without being pulled; the held call dones', [
    'A.return() #0',
    'r0 resolved {"done":true}',
  ]);

  // return() waits for BOTH closes (concurrently). Settling just the inner is not
  // enough...
  A.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('settling only the inner close does not resolve return()', []);

  // ...return() resolves once the underlying close also settles.
  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once both closes settle, return() resolves', ['ret resolved {"done":true}']);
}]);

// With more than one bound call, the trailing surplus is doned EAGERLY at return()
// time (it can never get a value), while the head-most bound call is held.
tests.push(['flatMap: return() while reading the underlying dones the surplus eagerly and holds the head call', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  // Demand 2; we won't pull, so the trailing call (r1) can never get a value -> done
  // it eagerly. The head call (r0) is held; the underlying is closed eagerly.
  src.holdReturn();
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  // (src.return() is a synchronous call; the surplus done is observed a microtask
  // later, so the close logs first.)
  t.expectLog('the surplus dones eagerly; the head is held; the underlying closes eagerly', [
    'src.return() #0',
    'r1 resolved {"done":true}',
  ]);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the in-flight underlying value is mapped', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  A.holdReturn();
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the produced iterator is closed without being pulled; the held call dones', [
    'A.return() #0',
    'r0 resolved {"done":true}',
  ]);

  A.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('return() still waits for the underlying close', []);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once both closes settle, return() resolves', ['ret resolved {"done":true}']);
}]);

// The in-flight pull REJECTS after return(). The rejection is the stream's and goes
// to the held call. No inner is produced, so return() waits only for the eager
// underlying close.
tests.push(['flatMap: return() while reading the underlying surfaces an underlying-pull rejection to the held call', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a pull is in flight', ['src.next() #0']);

  src.holdReturn();
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying is closed eagerly; the call is held', ['src.return() #0']);

  src.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the pull error reaches the held call; return() still awaits the close', [
    'r0 rejected boom',
  ]);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once the underlying close settles, return() resolves done', ['ret resolved {"done":true}']);
}]);

// The MAPPER rejects after return(). The underlying is already closing (eagerly), so
// we don't close it again; the mapper error is the stream's, withheld until that
// close settles, then delivered to the held call. No inner is produced.
tests.push(['flatMap: return() while reading the underlying, then the mapper rejects, surfaces the error to the held call', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a pull is in flight', ['src.next() #0']);

  src.holdReturn();
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying is closed eagerly; the call is held', ['src.return() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the in-flight underlying value is mapped', ['m(1) #0']);

  m.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the mapper error is withheld until the eager close settles', []);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once the close settles, the error reaches the held call and return() resolves', [
    'r0 rejected boom',
    'ret resolved {"done":true}',
  ]);
}]);

// CLOSE error on the success path: the produced iterator's .return() rejects. return()
// waits for both closes; once both settle it rejects with the inner-close error
// (inner taking precedence over the underlying).
tests.push(['flatMap: return() while reading the underlying rejects with the inner-close error when the produced .return() rejects', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a pull is in flight', ['src.next() #0']);

  src.holdReturn();
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying is closed eagerly; the call is held', ['src.return() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the in-flight underlying value is mapped', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  A.holdReturn();
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the produced iterator is closed without being pulled; the held call dones', [
    'A.return() #0',
    'r0 resolved {"done":true}',
  ]);

  // The inner .return() rejects, but return() still awaits the underlying close.
  A.settleReturnThrow(0, new Error('inner-close'));
  await flushMicrotasks();
  t.expectLog('the inner close rejected; return() still awaits the underlying close', []);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once both closes settle, return() rejects with the inner-close error', [
    'ret rejected inner-close',
  ]);
}]);

// return() while an inner iterator is active (and quiescent — its one delivered
// value left no pull in flight) closes BOTH the inner iterator and the
// underlying, in that order, and resolves done. A second return() is a no-op.
tests.push(['flatMap: return() closes the active inner iterator and the underlying, and is idempotent', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  // Deliver the one value so the active iterator has no pull in flight.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the value is delivered, leaving the inner iterator active but idle', [
    'r0 resolved {"value":"a0","done":false}',
  ]);

  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  // The active inner iterator is closed first, then the underlying.
  t.expectLog('return() closes the inner iterator then the underlying', [
    'A.return() #0',
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  const ret2 = fm.return();
  t.check('a second return() returns a promise', ret2 instanceof Promise, true);
  if (ret2 instanceof Promise) track(t.log, 'ret2', ret2);
  await flushMicrotasks();
  t.expectLog('a second return() closes nothing again', ['ret2 resolved {"done":true}']);
}]);

// return() after the underlying has cleanly finished must not close it.
tests.push(['flatMap: return() after a clean done does not close the source', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.finish(0);
  await flushMicrotasks();
  t.expectLog('the underlying is exhausted', ['r0 resolved {"done":true}']);

  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  // No src.return(): a finished source is not closed again.
  t.expectLog('return() after a clean done does not close the source', [
    'ret resolved {"done":true}',
  ]);
}]);

// return() after the underlying has errored must not close it.
tests.push(['flatMap: return() after an underlying error does not close the source', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the underlying error rejects the call', ['r0 rejected boom']);

  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  // No src.return(): the source faulted, so it is not closed.
  t.expectLog('return() after an underlying error does not close the source', [
    'ret resolved {"done":true}',
  ]);
}]);

// return() means "no more demand", but — as in map/filter — it does NOT cancel
// values that were already requested. Pulls already in flight on the active inner
// iterator when return() lands still deliver their values; closing the inner
// iterator (.return()) does not discard its outstanding .next() results.
tests.push(['flatMap: return() still delivers values already requested from the active inner iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('two inner pulls are in flight', ['A.next() #0', 'A.next() #1']);

  // return() closes the inner iterator and the underlying, but the two in-flight
  // inner pulls are NOT cancelled.
  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes both iterators without settling the in-flight calls', [
    'A.return() #0',
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  // The already-requested values still arrive, in call order.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the first already-requested value is delivered', [
    'r0 resolved {"value":"a0","done":false}',
  ]);

  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('the second already-requested value is delivered', [
    'r1 resolved {"value":"a1","done":false}',
  ]);

  const r2 = fm.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('a call made after return() is done', ['r2 resolved {"done":true}']);
}]);

// The in-order delivery guarantee survives return(): an already-requested value
// that settles out of order still waits for the earlier one.
tests.push(['flatMap: after return(), already-requested values are still delivered in order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('two inner pulls are in flight', ['A.next() #0', 'A.next() #1']);

  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes both iterators', [
    'A.return() #0',
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  // The second pull settles first; it must still wait for the first.
  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('a later value cannot settle ahead of the earlier one', []);

  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('both already-requested values settle in call order', [
    'r0 resolved {"value":"a0","done":false}',
    'r1 resolved {"value":"a1","done":false}',
  ]);
}]);

// --- Terminal events with coalesced demand / after return() ----------------

// A mapper error coalesced across several calls: while "reading underlying",
// concurrent calls share one underlying pull and one mapper invocation. When the
// mapper fails it closes the underlying, the first position takes the error (after
// the close settles), and the other coalesced calls — which can never be filled
// now the source is closing — settle done. (filter's terminal-error shape.)
tests.push(['flatMap: a mapper error with coalesced demand rejects one call and dones the surplus', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('a single mapper invocation', ['m(1) #0']);

  // The done settles immediately (the source is closing, so the surplus call can
  // never be filled); the error waits for src.return() to settle.
  m.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the surplus call is done, then the error reaches the first call', [
    'src.return() #0',
    'r1 resolved {"done":true}',
    'r0 rejected boom',
  ]);
}]);

// After return(), an already-requested inner pull that *errors* (instead of
// yielding) must still reach its call. Everything is already closed, so the error
// is surfaced directly with no further close.
tests.push(['flatMap: after return(), an inner error still reaches its already-requested call', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes both iterators', [
    'A.return() #0',
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  // The already-requested pull rejects; the error reaches its call (no new close).
  A.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the in-flight error reaches its call', ['r0 rejected boom']);
}]);

// After return(), an inner iterator that reports done settles only as many calls
// as it had outstanding — NOT every call behind it — because a later inner
// iterator's already-requested values still deliver, shifting forward to fill in.
tests.push(['flatMap: after return(), an inner done settles only its own outstanding calls; later values still deliver', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  const r2 = fm.next();
  const r3 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  track(t.log, 'r3', r3);
  await flushMicrotasks();
  t.expectLog('four coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 4 fans out across A', [
    'A.next() #0', 'A.next() #1', 'A.next() #2', 'A.next() #3',
  ]);

  // A reports done at pull #2 (pulls #0/#1 still in flight): it keeps [a0, a1] and
  // the freed demand (2) redirects to a second underlying pull -> iterator B.
  A.finish(2);
  await flushMicrotasks();
  t.expectLog('A done redirects the freed demand to another underlying pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across B', ['B.next() #0', 'B.next() #1']);

  // The flattened stream now stands at [a0, a1, b0, b1]. return() closes the
  // active iterator B and the underlying; A (already queued) and B keep their
  // in-flight pulls for delivery.
  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the active inner iterator and the underlying', [
    'B.return() #0',
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  // A reports done at its second outstanding pull (#1), with #0 still pending.
  // That ends A one value short, so the stream shrinks to [a0, b0, b1]: exactly
  // ONE call (the surplus tail, r3) settles done — not r1/r2, which B still feeds.
  A.finish(1);
  await flushMicrotasks();
  t.expectLog('only the single surplus call settles done', ['r3 resolved {"done":true}']);

  // The survivors deliver in concatenation order; B's values shift forward.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog("A's surviving value goes to the first call", [
    'r0 resolved {"value":"a0","done":false}',
  ]);

  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('the later iterator value shifts forward to the next call', [
    'r1 resolved {"value":"b0","done":false}',
  ]);

  B.yield(1, 'b1');
  await flushMicrotasks();
  t.expectLog('and the last survivor to the call after it', [
    'r2 resolved {"value":"b1","done":false}',
  ]);
}]);

// --- the two-close error path -----------------------------------------------
//
// When an inner iterator's *in-flight* pull rejects while a DIFFERENT inner
// iterator is still live, two things are open and must be closed: the live
// active iterator and the underlying. (The iterator whose pull rejected is
// already exhausted by that rejection, so it is not closed.) The two closes are
// done SEQUENTIALLY — active iterator first, then the underlying, matching the
// order return() uses — and the rejection is surfaced only once BOTH closes have
// settled. Any error from either .return() is swallowed; the original error wins.
//
// Setup for both tests below: inner A reports done with pull #0 still in flight
// (A is parked in the closed queue), the freed demand produces a live inner B,
// and then A's lingering pull #0 rejects.

tests.push(['flatMap: a mid-stream inner error closes the active iterator then the underlying, sequentially', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  // A reports done at pull #1 with pull #0 still in flight: A is parked in the
  // closed queue (keeping #0), and the freed demand (1) redirects to a new
  // underlying pull -> iterator B.
  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A done redirects the freed demand to another underlying pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('the redirected demand pulls the live inner B', ['B.next() #0']);

  // Hold both .return()s so we can observe their ordering and confirm the
  // rejection is withheld until both settle.
  src.holdReturn();
  B.holdReturn();

  // A's lingering pull #0 rejects. B is the live active iterator, so it is closed
  // FIRST; the underlying is not touched yet, and nothing is surfaced. B's
  // already-requested pull #0 is NOT discarded (the error stops new pulls, not
  // already-issued ones): it stays bound to r1.
  A.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the active inner iterator is closed first, alone', ['B.return() #0']);

  // Once B's close settles, the underlying is closed next — still no rejection.
  B.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('only then is the underlying closed', ['src.return() #0']);

  // Only after BOTH closes settle does the error reach the call scanning into A.
  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('the rejection surfaces after both closes settle', ['r0 rejected boom']);

  // B's already-requested pull settles after the close: its value still reaches
  // r1, exactly as an in-flight pull survives an explicit return().
  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('the already-requested inner value still reaches its call', [
    'r1 resolved {"value":"b0","done":false}',
  ]);
}]);

tests.push(['flatMap: the two-close error path swallows an error from closing the active iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A done redirects the freed demand to another underlying pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  // Hand-roll B so its .return() rejects (to prove that close error is swallowed)
  // while its already-issued pull #0 stays settleable (to prove its value still
  // reaches the call).
  const bReturn = Promise.withResolvers();
  const bPull = Promise.withResolvers();
  const B = {
    next() { t.log('B.next() #0'); return bPull.promise; },
    return() { t.log('B.return() #0'); return bReturn.promise; },
    [Symbol.asyncIterator]() { return this; },
  };
  m.resolve(1, B);
  await flushMicrotasks();
  t.expectLog('the redirected demand pulls the live inner B', ['B.next() #0']);

  // Hold the underlying close so its ordering after B is observable.
  src.holdReturn();

  A.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the active inner iterator is closed first, alone', ['B.return() #0']);

  // B's close FAILS. The failure is swallowed; the underlying is still closed.
  bReturn.reject(new Error('inner-close-fail'));
  await flushMicrotasks();
  t.expectLog('the close failure is swallowed and the underlying is still closed', ['src.return() #0']);

  // The original error (not the close failure) surfaces once both closes settle.
  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('the original error wins once both closes settle', ['r0 rejected boom']);

  // B's already-issued pull #0 still delivers its value to r1.
  bPull.resolve({ value: 'b0', done: false });
  await flushMicrotasks();
  t.expectLog('the already-requested inner value still reaches its call', [
    'r1 resolved {"value":"b0","done":false}',
  ]);
}]);

// --- what an error does (and does not do) to other in-flight calls ----------
//
// An error stops NEW pulls (the active inner iterator and the underlying are
// closed) but does not discard work already in flight: a call already bound to an
// issued pull still receives that pull's value when it settles, exactly as in
// map and as an explicit return() leaves already-requested values deliverable.
// (The two two-close tests above show this for a separate active iterator.) The
// "settle done" rule applies only to calls that were never bound to a pull —
// coalesced surplus demand — which is the underlying-error case further below.

// Single-close path: an EARLIER pull of the active iterator errors while a LATER
// pull of the same iterator is still in flight. The later pull was already issued,
// so its value still reaches its call after the error — it is not discarded.
tests.push(['flatMap: an inner error still delivers a later already-issued pull on the same iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across the active iterator', ['A.next() #0', 'A.next() #1']);

  // A's earlier pull (#0) rejects while pull #1 is still in flight. #0 is the head,
  // so it closes the underlying and its error is committed to r0 (surfacing once
  // src.return() settles). Pull #1 was already issued, so it stays bound to r1.
  A.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the underlying closes, then the error reaches the first call', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  // A's already-issued pull #1 settles after the error: its value still reaches r1.
  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('the already-requested inner value still reaches its call', [
    'r1 resolved {"value":"a1","done":false}',
  ]);
}]);

// Underlying-error path with buffered values ahead of the error. An earlier inner
// iterator is parked with in-flight pulls (buffered, ahead in the stream) when the
// underlying errors fetching the NEXT iterator. The buffered values must still
// deliver, the error must reach the call at that position, and any surplus is
// doned — the error must NOT be swallowed into a clean done.
tests.push(['flatMap: an underlying error behind buffered values still surfaces after them', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  const r2 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('three coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 3 fans out across A', ['A.next() #0', 'A.next() #1', 'A.next() #2']);

  // A reports done at pull #2 with #0/#1 still in flight: A is parked keeping
  // [a0, a1], and the freed demand (1) redirects to a second underlying pull.
  A.finish(2);
  await flushMicrotasks();
  t.expectLog('A done redirects the freed demand to another underlying pull', ['src.next() #1']);

  // The underlying errors fetching the next iterator. It is NOT closed (it errored
  // itself), and nothing surfaces yet: the error sits behind A's buffered values.
  src.throw(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the underlying error is buffered behind the parked values', []);

  // A's buffered values deliver in order; draining A then exposes the error to the
  // call at that position.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the first buffered value is delivered', ['r0 resolved {"value":"a0","done":false}']);

  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('the last buffered value is delivered, then the error surfaces', [
    'r1 resolved {"value":"a1","done":false}',
    'r2 rejected boom',
  ]);
}]);

// --- bookkeeping when an earlier pull is delivered before a later one settles --

// The active iterator yields an early value (which is delivered and shifts off the
// queue) and only THEN does a later pull of the same iterator report done. The
// freed demand must still redirect to a fresh underlying pull, so the trailing
// call is satisfied by the next iterator — it must not be left hanging.
tests.push(['flatMap: a delivered early value does not corrupt a later same-iterator done', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  const r2 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('three coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 3 fans out across A', ['A.next() #0', 'A.next() #1', 'A.next() #2']);

  // Deliver A's first value: it is dispatched and shifts off the head of the queue.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the first value is delivered', ['r0 resolved {"value":"a0","done":false}']);

  // Now A's LAST pull (#2) reports done while #1 is still in flight. A keeps [a1]
  // and the freed demand (1, for r2) redirects to a fresh underlying pull.
  A.finish(2);
  await flushMicrotasks();
  t.expectLog('the freed demand redirects to another underlying pull', ['src.next() #1']);

  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('the second value is delivered', ['r1 resolved {"value":"a1","done":false}']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the second underlying value is mapped', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('the redirected demand pulls the second iterator once', ['B.next() #0']);

  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('the trailing call is satisfied by the next iterator', [
    'r2 resolved {"value":"b0","done":false}',
  ]);
}]);

// A pull of an ALREADY-PARKED iterator rejects while the helper is between inner
// iterators (reading the underlying for the next one). The error belongs to the
// parked iterator's position, so it closes the underlying and reaches that call;
// the demand that was coalesced for the NEXT iterator sits after the error and can
// never be filled, so those calls settle done.
tests.push(['flatMap: a parked-iterator pull error while reading underlying dones the pending demand', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  // A reports done at pull #1 with pull #0 still in flight: A is parked keeping #0,
  // and the freed demand (1, aimed at the NEXT iterator) reads the underlying again.
  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A done redirects the freed demand to another underlying pull', ['src.next() #1']);

  // A's parked pull #0 now rejects. It closes the underlying and its error reaches
  // r0; the pending demand for the next iterator (r1) can never be filled -> done.
  A.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the underlying closes, the pending demand is doned, then the error surfaces', [
    'src.return() #0',
    'r1 resolved {"done":true}',
    'r0 rejected boom',
  ]);
}]);

// A later iterator's value settles while it is still queued behind an earlier
// parked iterator (so it is buffered, not delivered). When that parked iterator is
// then exhausted, the buffered value becomes the head of the queue and must be
// flushed to its call — removing the parked iterator cannot leave it stranded.
tests.push(['flatMap: exhausting a parked iterator flushes a value already buffered behind it', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  // A reports done at pull #1 with pull #0 still in flight: A is parked keeping #0,
  // and the freed demand (1) redirects to a fresh underlying pull -> iterator B.
  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A done redirects the freed demand to another underlying pull', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the second underlying value is mapped', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('the redirected demand pulls B once', ['B.next() #0']);

  // B's value settles, but it sits behind A's still-pending pull #0, so it waits.
  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('the later value is buffered behind the parked iterator', []);

  // A's pull #0 now reports done, exhausting A entirely. b0 becomes the head and
  // must flush to r0; the freed demand redirects to a fresh pull of B.
  A.finish(0);
  await flushMicrotasks();
  t.expectLog('exhausting the parked iterator flushes the buffered value', [
    'B.next() #1',
    'r0 resolved {"value":"b0","done":false}',
  ]);

  B.yield(1, 'b1');
  await flushMicrotasks();
  t.expectLog('the next value is delivered too', ['r1 resolved {"value":"b1","done":false}']);
}]);

// Same flush hazard, but the parked iterator is exhausted while the helper is
// READING THE UNDERLYING (not while another iterator is active). Two iterators are
// parked; the second already has a buffered value; exhausting the first must flush
// that value even though the active state is "reading underlying".
tests.push(['flatMap: exhausting a parked iterator while reading underlying flushes a buffered value', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  // Iterator A: pulled twice, reports done on #1 -> parked keeping #0 in flight.
  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks; freed demand reads the underlying', ['src.next() #1']);

  // Iterator B becomes active; a third call gives it a second pull so it too can be
  // parked, with its first value buffered behind A.
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('B is pulled once for the outstanding call', ['B.next() #0']);

  const r2 = fm.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('a third call gives B a second pull', ['B.next() #1']);

  // B reports done on #1 -> parked keeping #0 in flight; freed demand reads the
  // underlying again. Now BOTH A and B are parked, and the helper is reading.
  B.finish(1);
  await flushMicrotasks();
  t.expectLog('B parks; freed demand reads the underlying again', ['src.next() #2']);

  // B's pull #0 settles, but it sits behind A, so it is buffered, not delivered.
  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('B0 is buffered behind A', []);

  // A is exhausted (its only remaining pull reports done) while reading underlying.
  // b0 becomes the head and must flush to r0.
  A.finish(0);
  await flushMicrotasks();
  t.expectLog('exhausting A flushes the value buffered behind it', [
    'r0 resolved {"value":"b0","done":false}',
  ]);
}]);

// Same flush hazard once the helper is FINISHED (here via return()): a value is
// buffered in a parked iterator behind another parked iterator; exhausting the
// front one must flush that buffered value, even though no more pulls will happen.
tests.push(['flatMap: exhausting a parked iterator after return() flushes a buffered value', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  // A: pulled twice, done on #1 -> parked keeping #0 in flight.
  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks; freed demand reads the underlying', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('B is pulled once', ['B.next() #0']);

  // A third call gives B a second in-flight pull (so both calls are bound to it).
  const r2 = fm.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('a third call gives B a second pull', ['B.next() #1']);

  // B's first value settles, buffered behind A's still-pending pull #0.
  B.yield(0, 'B0');
  await flushMicrotasks();
  t.expectLog('B0 is buffered behind A', []);

  // return() closes B and the underlying; already-requested pulls stay deliverable.
  const ret = fm.return();
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the active iterator and the underlying', [
    'B.return() #0',
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

  // A's last pull reports done, exhausting A while the helper is already finished.
  // A contributed nothing, so its surplus call is doned and B0 flushes forward.
  A.finish(0);
  await flushMicrotasks();
  t.expectLog('exhausting A dones the surplus and flushes the buffered value', [
    'r2 resolved {"done":true}',
    'r0 resolved {"value":"B0","done":false}',
  ]);

  B.yield(1, 'B1');
  await flushMicrotasks();
  t.expectLog('the remaining buffered value is delivered', [
    'r1 resolved {"value":"B1","done":false}',
  ]);
}]);

// ============================================================================
// Additional coverage (gaps found by review)
// ============================================================================

// --- demand coalescing in the mapper-pending window -------------------------
//
// The existing coalescing tests raise demand BEFORE the underlying yields. There
// is a second, distinct window: after the underlying has yielded but while the
// mapper promise is still pending, the helper is still "reading underlying", so a
// next() that lands here must also be absorbed (no extra underlying pull, no extra
// mapper call) and fan out onto the single resulting inner iterator.
tests.push(['flatMap: a next() during the mapper-pending window coalesces onto the same inner iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked, now pending', ['m(1) #0']);

  // This call lands while the mapper is still pending. It must NOT pull the
  // underlying again or invoke the mapper again — it only raises demand.
  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a next() while the mapper is pending neither pulls nor maps again', []);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  // Demand accumulated to 2 across the pending window, so A fans out twice.
  t.expectLog('the accumulated demand fans out onto the single inner iterator', [
    'A.next() #0',
    'A.next() #1',
  ]);

  A.yield(0, 'a0');
  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('both values are delivered in call order', [
    'r0 resolved {"value":"a0","done":false}',
    'r1 resolved {"value":"a1","done":false}',
  ]);
}]);

// --- mapper returns a non-iterable ------------------------------------------
//
// The mapper is supposed to return an (async) iterable. If it resolves to a value
// with no [Symbol.asyncIterator], obtaining the inner iterator throws. That is a
// failure attributable to consuming the underlying's value, so — like a mapper
// throw — it closes the underlying and rejects the call.
tests.push(['flatMap: a mapper that resolves to a non-iterable closes the underlying and rejects', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  // Track the rejection reason out-of-band: the exact TypeError message is
  // engine/implementation-internal, so we assert its type rather than its text.
  let caught = 'no rejection';
  const r0 = fm.next();
  r0.then(() => {}, e => { caught = e; });
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  m.resolve(0, {});
  await flushMicrotasks();
  // Obtaining the inner iterator throws synchronously; that closes the source and
  // the call rejects (the rejection only surfaces after the close settles).
  t.expectLog('obtaining the inner iterator fails, closing the source', ['src.return() #0']);
  t.check('the call rejects with a TypeError', caught instanceof TypeError, true);

  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// --- a NON-head pull of the active iterator errors --------------------------
//
// The single-close error test (above) has the HEAD pull of the active iterator
// reject. The dual case is a LATER pull rejecting while the head pull of the same
// active iterator is still in flight: the error is not at the head, so closing the
// underlying must happen but the rejection must wait behind the still-pending
// earlier pull, whose value is delivered first.
tests.push(['flatMap: a non-head pull of the active iterator errors behind a still-pending earlier pull', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across the active iterator', ['A.next() #0', 'A.next() #1']);

  // The LATER pull (#1) rejects while the head pull (#0) is still in flight. The
  // underlying closes, but the error sits behind #0, so nothing surfaces yet.
  A.throw(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the source closes but the error waits behind the earlier pull', [
    'src.return() #0',
  ]);

  // The head pull yields: its value reaches r0, then the queued error reaches r1.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the earlier value is delivered, then the error reaches the later call', [
    'r0 resolved {"value":"a0","done":false}',
    'r1 rejected boom',
  ]);
}]);

// --- two concurrent inner pulls that BOTH error -----------------------------
//
// Two concurrent pulls of the same active inner iterator are in flight; both
// reject. An error is not a wall that swallows later already-issued pulls: each
// pull delivers its own result in order, so BOTH errors surface (r0 then r1).
// (Settling a later in-flight pull done instead would be wrong: if a *third*
// pull had yielded a value, a done at r1 would sit ahead of that real value.)
tests.push(['flatMap: two concurrent inner pulls that both reject surface both errors in order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across the active iterator', ['A.next() #0', 'A.next() #1']);

  // The head pull rejects: it closes the underlying and its error reaches r0.
  A.throw(0, new Error('boom0'));
  await flushMicrotasks();
  t.expectLog('the head error closes the underlying, then reaches the first call', [
    'src.return() #0',
    'r0 rejected boom0',
  ]);

  // The second already-issued pull also rejects: its error reaches r1 (not a done).
  A.throw(1, new Error('boom1'));
  await flushMicrotasks();
  t.expectLog('the second already-issued error reaches the second call', [
    'r1 rejected boom1',
  ]);
}]);

// Same as above but the pulls reject in the OTHER order: the LATER pull (#1)
// rejects first (it is the active iterator's error, so it closes the underlying)
// but sits behind the still-pending head pull. When the head pull then rejects,
// both errors drain in call order, each call getting its own pull's error.
tests.push(['flatMap: two concurrent inner pulls that both reject (later first) still surface both in order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across the active iterator', ['A.next() #0', 'A.next() #1']);

  // The later pull rejects first: closes the underlying, but waits behind #0.
  A.throw(1, new Error('boom1'));
  await flushMicrotasks();
  t.expectLog('the later error closes the underlying but waits behind the head pull', [
    'src.return() #0',
  ]);

  // The head pull rejects: both errors drain in call order.
  A.throw(0, new Error('boom0'));
  await flushMicrotasks();
  t.expectLog('both errors drain in call order', [
    'r0 rejected boom0',
    'r1 rejected boom1',
  ]);
}]);

// Errors from DIFFERENT inner iterators. A reports done with pull #0 still in
// flight (parked, feeding r0); the freed demand yields a live iterator B (its
// pull #0 feeds r1). A's parked pull rejects FIRST while B is still live: the
// active iterator B is closed first, then the underlying, then A's error reaches
// r0. B's already-issued pull then rejects and reaches r1.
tests.push(['flatMap: errors from two different inner iterators (parked first) surface both in order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks keeping pull #0; freed demand reads the underlying', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('the live inner B is pulled once', ['B.next() #0']);

  // A's parked pull rejects while B is live: close active B first, then the
  // underlying, then A's error reaches r0.
  A.throw(0, new Error('boomA'));
  await flushMicrotasks();
  t.expectLog('the active iterator and underlying are closed, then A errors to r0', [
    'B.return() #0',
    'src.return() #0',
    'r0 rejected boomA',
  ]);

  // B's already-issued pull rejects and reaches r1 (no further close).
  B.throw(0, new Error('boomB'));
  await flushMicrotasks();
  t.expectLog('B errors to the second call', ['r1 rejected boomB']);
}]);

// Same two-iterator setup, OTHER order: the live iterator B rejects FIRST. B is
// exhausted by its own error and A is already done, so only the underlying is
// closed (no B.return()). The error waits behind A's still-pending parked pull;
// when A then rejects, both errors drain in call order: r0 <- A, r1 <- B.
tests.push(['flatMap: errors from two different inner iterators (active first) surface both in order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks keeping pull #0; freed demand reads the underlying', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('the live inner B is pulled once', ['B.next() #0']);

  // B (the live active iterator) rejects first: exhausted by its own error, and A
  // is already done, so only the underlying is closed. The error waits behind A.
  B.throw(0, new Error('boomB'));
  await flushMicrotasks();
  t.expectLog('only the underlying is closed; nothing surfaces yet', ['src.return() #0']);

  // A's parked pull rejects: both errors drain in call order.
  A.throw(0, new Error('boomA'));
  await flushMicrotasks();
  t.expectLog('both errors drain in call order', [
    'r0 rejected boomA',
    'r1 rejected boomB',
  ]);
}]);

// One error from an inner iterator, one from the mapper. A is parked with pull #0
// in flight (feeding r0); the freed demand is mid-mapper for the NEXT iterator
// (feeding r1). The parked inner rejects FIRST: while "reading underlying" that
// closes the underlying, dones the pending demand (r1), and A's error reaches r0.
// The still-pending mapper then rejecting is harmlessly ignored (already finished).
tests.push(['flatMap: an inner error then a mapper error (inner first) ignores the late mapper error', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks keeping pull #0; freed demand reads the underlying', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again, now pending', ['m(2) #1']);

  // A's parked pull rejects while the mapper is pending: close the underlying,
  // done the pending demand (r1), and surface A's error to r0.
  A.throw(0, new Error('boomA'));
  await flushMicrotasks();
  t.expectLog('the underlying closes, the pending demand is doned, then A errors to r0', [
    'src.return() #0',
    'r1 resolved {"done":true}',
    'r0 rejected boomA',
  ]);

  // The still-pending mapper now rejects: the helper is already finished, so it is
  // ignored (no extra close, no surfaced error).
  m.reject(1, new Error('boomM'));
  await flushMicrotasks();
  t.expectLog('the late mapper rejection is ignored', []);
}]);

// TODO it is kind of weird that this is observably different than previous case.
// Maybe that'll be fixed if/when we start waiting for mapper results.
// Same setup, OTHER order: the mapper rejects FIRST. While "reading underlying"
// the mapper error closes the underlying and takes the position the next iterator
// would have filled (r1), but waits behind A's still-pending parked pull. When A
// then rejects, both errors drain in call order: r0 <- A's inner error, r1 <- the
// mapper error.
tests.push(['flatMap: a mapper error then an inner error (mapper first) surfaces both in order', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks keeping pull #0; freed demand reads the underlying', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again, now pending', ['m(2) #1']);

  // The mapper rejects first: it closes the underlying and takes r1's position,
  // but waits behind A's still-pending parked pull.
  m.reject(1, new Error('boomM'));
  await flushMicrotasks();
  t.expectLog('the mapper error closes the underlying but waits behind the parked pull', [
    'src.return() #0',
  ]);

  // A's parked pull rejects: both errors drain in call order.
  A.throw(0, new Error('boomA'));
  await flushMicrotasks();
  t.expectLog('both errors drain in call order', [
    'r0 rejected boomA',
    'r1 rejected boomM',
  ]);
}]);

// --- multiple parked iterators + a clean underlying done --------------------
//
// Two iterators are parked (each keeping one in-flight pull) when the underlying
// is cleanly exhausted while reading for the next one. The terminal done caps only
// the un-serviceable surplus (one call), and the two buffered values then drain in
// concatenation order across the two closed-queue entries.
tests.push(['flatMap: a clean underlying done with two parked iterators caps the surplus and drains both', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  // A: pulled twice, done on #1 -> parked keeping #0 in flight.
  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks; freed demand reads the underlying', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('B is pulled once', ['B.next() #0']);

  // A third call gives B a second pull so B too can be parked.
  const r2 = fm.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('a third call gives B a second pull', ['B.next() #1']);

  B.finish(1);
  await flushMicrotasks();
  t.expectLog('B parks; freed demand reads the underlying again', ['src.next() #2']);

  // The underlying is now cleanly exhausted while both A and B are parked. The
  // stream is [a0, b0] plus the surplus call r2, which can never be filled.
  src.finish(2);
  await flushMicrotasks();
  t.expectLog('the terminal done caps only the surplus call (no source.return on a clean done)', [
    'r2 resolved {"done":true}',
  ]);

  // The two buffered values now drain in order across the two closed-queue entries.
  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the first parked value is delivered', ['r0 resolved {"value":"a0","done":false}']);

  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('the second parked value is delivered', ['r1 resolved {"value":"b0","done":false}']);
}]);

// --- an underlying error behind TWO parked iterators ------------------------
//
// The existing underlying-error-behind-buffered-values test parks a single
// iterator. This parks two: the error (fetching the third iterator) must keep one
// call for itself and one per buffered value, drain both parked entries in order,
// and only then surface — across MULTIPLE closed-queue entries.
tests.push(['flatMap: an underlying error behind two parked iterators drains both then surfaces', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks; freed demand reads the underlying', ['src.next() #1']);

  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked again', ['m(2) #1']);

  const B = controlledSource(t.log, 'B');
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('B is pulled once', ['B.next() #0']);

  const r2 = fm.next();
  track(t.log, 'r2', r2);
  await flushMicrotasks();
  t.expectLog('a third call gives B a second pull', ['B.next() #1']);

  B.finish(1);
  await flushMicrotasks();
  t.expectLog('B parks; freed demand reads the underlying again', ['src.next() #2']);

  // The underlying errors fetching the third iterator. It is NOT closed; the error
  // sits behind A's and B's buffered values, keeping exactly one call for itself.
  src.throw(2, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the underlying error is buffered behind both parked iterators', []);

  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the first parked value is delivered', ['r0 resolved {"value":"a0","done":false}']);

  // Draining B exposes the error to the call at its position.
  B.yield(0, 'b0');
  await flushMicrotasks();
  t.expectLog('the second parked value is delivered, then the error surfaces', [
    'r1 resolved {"value":"b0","done":false}',
    'r2 rejected boom',
  ]);
}]);

// --- close failures: a .return() that throws/rejects ------------------------
//
// As in map/filter, a consumer return() propagates a close failure to its own
// result (after still attempting the other close), while a close failure during
// ERROR-driven cleanup is swallowed (the original stream error wins). And an
// iterator with no .return() method at all must be tolerated.

// return() closes the active inner first; if THAT close throws synchronously, the
// underlying is still closed, and return() rejects with the inner-close error.
tests.push(['flatMap: return() rejects with the inner-close error when the active inner .return() throws', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the value is delivered, leaving the inner active and idle', [
    'r0 resolved {"value":"a0","done":false}',
  ]);

  // The active inner's .return() throws; the underlying is still closed, and the
  // inner-close error is what return() rejects with.
  A.throwReturn(new Error('inner-close'));
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the inner close throws, the underlying is still closed, return() rejects', [
    'A.return() #0 (throws)',
    'src.return() #0',
    'ret rejected inner-close',
  ]);
}]);

// return()'s inner close succeeds but the UNDERLYING close throws; return()
// rejects with the underlying-close error.
tests.push(['flatMap: return() rejects with the underlying-close error when the underlying .return() throws', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the value is delivered, leaving the inner active and idle', [
    'r0 resolved {"value":"a0","done":false}',
  ]);

  src.throwReturn(new Error('underlying-close'));
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the inner closes, then the underlying close throws and return() rejects', [
    'A.return() #0',
    'src.return() #0 (throws)',
    'ret rejected underlying-close',
  ]);
}]);

// CLOSE error on the success path, on the UNDERLYING this time: the inner .return()
// succeeds but the eager underlying .return() rejects ASYNCHRONOUSLY. return() waits
// for both closes, then rejects with the underlying-close error.
tests.push(['flatMap: return() while reading underlying rejects with the underlying-close error when the underlying .return() rejects', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a pull is in flight', ['src.next() #0']);

  src.holdReturn();
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying is closed eagerly; the call is held', ['src.return() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the in-flight underlying value is mapped', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  A.holdReturn();
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the produced iterator is closed without being pulled; the held call dones', [
    'A.return() #0',
    'r0 resolved {"done":true}',
  ]);

  // The inner close settles cleanly; return() still awaits the underlying close.
  A.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('the inner closed cleanly; return() still awaits the underlying close', []);

  // The underlying .return() rejects: return() rejects with the underlying-close error.
  src.settleReturnThrow(0, new Error('underlying-close'));
  await flushMicrotasks();
  t.expectLog('once the underlying close rejects, return() rejects with it', [
    'ret rejected underlying-close',
  ]);
}]);

// Iterators with NO .return() method at all are tolerated: return() closes
// nothing and resolves done.
tests.push(['flatMap: return() tolerates a source and inner iterator that lack .return()', async function (t) {
  const src = controlledSource(t.log, 'src');
  delete src.iterator.return; // a source without a .return() method
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  delete A.iterator.return; // an inner iterator without a .return() method
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  A.yield(0, 'a0');
  await flushMicrotasks();
  t.expectLog('the value is delivered', ['r0 resolved {"value":"a0","done":false}']);

  // Neither iterator has a .return(): there is nothing to close, so return()
  // simply resolves done (no crash).
  const ret = fm.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  if (ret instanceof Promise) track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes nothing and resolves done', ['ret resolved {"done":true}']);

  const r1 = fm.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a next() after return() is done', ['r1 resolved {"done":true}']);
}]);

// On the ERROR path, a close failure is swallowed and the original stream error
// wins. Here an inner pull errors (closing the underlying) and the underlying
// .return() throws synchronously: the throw is swallowed, r0 still rejects with
// the inner error.
tests.push(['flatMap: an inner error swallows a synchronous underlying-close throw; the stream error wins', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  // The inner pull errors (the terminal stream error). Closing the underlying
  // throws, which is swallowed; r0 still rejects with the inner error.
  src.throwReturn(new Error('underlying-close'));
  A.throw(0, new Error('boom-inner'));
  await flushMicrotasks();
  t.expectLog('the underlying-close throw is swallowed; the inner error reaches r0', [
    'src.return() #0 (throws)',
    'r0 rejected boom-inner',
  ]);
}]);

// Same, but the underlying .return() rejects ASYNCHRONOUSLY: the rejection is
// swallowed, and the inner error surfaces only once the close settles.
tests.push(['flatMap: an inner error swallows an async underlying-close rejection; the stream error wins', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the inner iterator is pulled', ['A.next() #0']);

  src.holdReturn();
  A.throw(0, new Error('boom-inner'));
  await flushMicrotasks();
  // The underlying close is issued (pending); the error waits for it to settle.
  t.expectLog('the underlying close is pending; the error is withheld', ['src.return() #0']);

  src.settleReturnThrow(0, new Error('underlying-close'));
  await flushMicrotasks();
  t.expectLog('the close rejection is swallowed; the inner error reaches r0', [
    'r0 rejected boom-inner',
  ]);
}]);

// A head inner-iterator error closes the underlying via it.return(); while that
// close is still PENDING, a value already buffered behind the error (from a later
// pull of the same iterator) is delivered immediately to its call — the committed
// head error's recipient is fixed, so following values needn't wait for the close.
// Only the errored call waits for it.return() to settle. (The flatMap analogue of
// filter's "head predicate-error close delivers the value behind it immediately".)
tests.push(['flatMap: a held inner-error close delivers a value buffered behind it without waiting', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  const r1 = fm.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked once', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across the active iterator', ['A.next() #0', 'A.next() #1']);

  // The later pull (#1) yields first: a1 is buffered behind the still-pending head
  // pull (#0).
  A.yield(1, 'a1');
  await flushMicrotasks();
  t.expectLog('the later value is buffered behind the pending head', []);

  // The head pull (#0) errors with the underlying close held pending. The error is
  // committed to r0 (withheld), and the buffered a1 is delivered to r1 immediately
  // — without waiting for it.return() to settle.
  src.holdReturn();
  A.throw(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the close is pending; the buffered value delivers while the error waits', [
    'src.return() #0',
    'r1 resolved {"value":"a1","done":false}',
  ]);

  // Only once it.return() settles does the errored call reject.
  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('the errored call rejects once the close settles', ['r0 rejected boom']);
}]);

// --- return() while blocked on a pending mapper -----------------------------
//
// Structurally distinct from the tests above: return() lands AFTER the source has
// yielded and the mapper was invoked (so the mapper promise is pending), rather
// than while the underlying pull is in flight. The underlying still closes eagerly
// at return(); when the mapper resolves to an iterable we close it WITHOUT pulling,
// done the held call, and return() waits for both closes.
tests.push(['flatMap: return() while blocked on the mapper closes the produced iterator without pulling it', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const r0 = fm.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls the underlying', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked, now pending', ['m(1) #0']);

  // return() lands while the mapper is still pending. The underlying closes eagerly;
  // r0 is held.
  src.holdReturn();
  const ret = fm.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying is closed eagerly; the call is held', ['src.return() #0']);

  const A = controlledSource(t.log, 'A');
  A.holdReturn();
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('the produced iterator is closed without being pulled; the held call dones', [
    'A.return() #0',
    'r0 resolved {"done":true}',
  ]);

  A.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('return() still waits for the underlying close', []);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once both closes settle, return() resolves', ['ret resolved {"done":true}']);
}]);

// return() while reading underlying with a PARKED iterator ahead. An inner iterator
// (A) reported done one short and is parked feeding p1 with an in-flight pull; the
// freed demand redirected to a fresh underlying pull that is now in flight. On
// return(): the bound demand's surplus (p3) dones eagerly, the head-most bound call
// (p2) is held, p1 keeps its parked pull, and the underlying closes eagerly. When the
// in-flight pull yields, its iterator (B) is closed WITHOUT pulling and p2 dones; the
// parked value still reaches p1.
tests.push(['flatMap: return() while reading underlying with a parked iterator delivers the parked value and dones the rest', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const p1 = fm.next();
  const p2 = fm.next();
  const p3 = fm.next();
  track(t.log, 'p1', p1);
  track(t.log, 'p2', p2);
  track(t.log, 'p3', p3);
  await flushMicrotasks();
  t.expectLog('three coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 3 fans out across A', ['A.next() #0', 'A.next() #1', 'A.next() #2']);

  // A reports done at its MIDDLE pull (#1) with #0 still in flight: A parks keeping
  // A#0 (feeding p1); the freed demand (2, for p2/p3) reads the underlying again.
  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks; the freed demand reads the underlying again', ['src.next() #1']);

  // return() while reading underlying. Bound demand is 2 (p2, p3): the trailing one
  // (p3) dones eagerly; p2 (head-most bound) is held; p1 keeps its parked pull; the
  // underlying closes eagerly.
  src.holdReturn();
  const pr = fm.return();
  track(t.log, 'pr', pr);
  await flushMicrotasks();
  // (src.return() is synchronous; the surplus done is observed a microtask later.)
  t.expectLog('the surplus dones eagerly; the underlying closes eagerly', [
    'src.return() #0',
    'p3 resolved {"done":true}',
  ]);

  // The in-flight pull yields a value; the mapper is invoked again.
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('the in-flight underlying value is mapped', ['m(2) #1']);

  // The mapper resolves to iterator B: close it WITHOUT pulling; the held bound call
  // (p2) dones. p1 is still owed its parked value.
  const B = controlledSource(t.log, 'B');
  B.holdReturn();
  m.resolve(1, B.iterator);
  await flushMicrotasks();
  t.expectLog('the produced iterator is closed without being pulled; the held call dones', [
    'B.return() #0',
    'p2 resolved {"done":true}',
  ]);

  B.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('return() still waits for the underlying close', []);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once both closes settle, return() resolves', ['pr resolved {"done":true}']);

  // p1's parked pull finally yields: it still gets its value.
  A.yield(0, 'a1');
  await flushMicrotasks();
  t.expectLog('the parked value still reaches the first call', [
    'p1 resolved {"value":"a1","done":false}',
  ]);
}]);

// Same parked setup, but the in-flight pull REJECTS. The error is queued behind p1's
// still-pending parked value and reaches the held call (p2) only after p1 is
// delivered. return() waits for the eager underlying close.
tests.push(['flatMap: return() while reading underlying surfaces a pull rejection behind a parked value', async function (t) {
  const src = controlledSource(t.log, 'src');
  const m = controlledFn(t.log, 'm');
  const fm = flatMap(src.iterator, m.fn);

  const p1 = fm.next();
  const p2 = fm.next();
  track(t.log, 'p1', p1);
  track(t.log, 'p2', p2);
  await flushMicrotasks();
  t.expectLog('two coalesced calls, one underlying pull', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the mapper is invoked', ['m(1) #0']);

  const A = controlledSource(t.log, 'A');
  m.resolve(0, A.iterator);
  await flushMicrotasks();
  t.expectLog('demand 2 fans out across A', ['A.next() #0', 'A.next() #1']);

  A.finish(1);
  await flushMicrotasks();
  t.expectLog('A parks; the freed demand reads the underlying again', ['src.next() #1']);

  // Bound demand is 1 (p2): nothing to done eagerly (p2 is held); p1 keeps its parked
  // pull; the underlying closes eagerly.
  src.holdReturn();
  const pr = fm.return();
  track(t.log, 'pr', pr);
  await flushMicrotasks();
  t.expectLog('the underlying closes eagerly; the calls are held', ['src.return() #0']);

  // The in-flight pull rejects: the error is queued behind p1's still-pending parked
  // value. No inner is produced, so return() waits only for the eager underlying close.
  src.throw(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('the pull error is queued behind the parked value', []);

  // p1's parked pull yields: p1 gets its value, then the error surfaces to p2.
  A.yield(0, 'a1');
  await flushMicrotasks();
  t.expectLog('the parked value is delivered, then the error reaches the held call', [
    'p1 resolved {"value":"a1","done":false}',
    'p2 rejected boom',
  ]);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('once the underlying close settles, return() resolves done', ['pr resolved {"done":true}']);
}]);

runTests(tests, xfailed);

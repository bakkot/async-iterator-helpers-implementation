import { flatMap } from '../flatMap.ts';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';

let tests = [];

// NOTE: flatMap.ts is an untested, work-in-progress implementation, so these
// tests are expected to FAIL for now. They exist to pin down the intended
// concurrent *happy-path* semantics — no error handling and no return() yet.
//
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

runTests(tests);

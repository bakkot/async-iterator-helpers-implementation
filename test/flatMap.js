// The flatMap helper's unit tests. Converted (2026-06-10) from the former
// hand-written test/flatMap.js (async-iterator-implementation), since deleted
// along with the converter: this file is the source of truth — edit it by
// hand. Run directly, or via test/scenario-tests.js in the implementation
// repo. tools/unconvert-tests.js there renders these files back into the
// old hand-written style for review.
//
// Most tests are scenario objects (see ./FORMAT.md) turned into runnable
// [name, fn] tests by scenarioTest; tests the scenario format cannot
// express were copied verbatim from the original file, each marked with a
// [copied verbatim] comment giving the reason.

import { flatMap } from '../flatMap.ts';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';
import * as utils from './utils.js';
import { scenarioTest } from './scenario-to-test.js';

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

let tests = [];
let xfailed = [];

// The simple sequential case. A single inner iterator yields two values (one per
// consumer call), then reports done — which is NOT the end of the stream but a
// cue to pull the underlying again. The underlying is then exhausted, and only
// that terminal underlying done propagates as a consumer `done`. Also pins
// laziness: an inner iterator is only pulled when there is demand for it.
tests.push(scenarioTest({
  id: "flatmap-test-001",
  helper: "flatMap",
  label: "flatMap: sequential across a single inner iterator, then a re-pull, then done",
  ticks: [
    { note: "first next() pulls the underlying once", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the underlying value is handed to the mapper", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The mapper produced inner iterator A; demand was 1, so A is pulled once.
    { note: "the inner iterator is pulled to satisfy the one outstanding call", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    { note: "the inner value is delivered to the first call", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    // A second consumer call pulls the *same* active inner iterator (not the
    // underlying) — and only now, on demand.
    { note: "a later call pulls the same inner iterator again", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "the second inner value is delivered", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
    // A third call pulls A again; A then reports done.
    { note: "a third call pulls the inner iterator once more", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
    ] } ] },
    // Inner done is not the end: the outstanding demand (1) is redirected to a
    // fresh underlying pull.
    { note: "inner done redirects demand to a new underlying pull", steps: [ { events: [
      { type: "settle", pull: "a2", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // The underlying is exhausted — THIS done is terminal and reaches the consumer.
    { note: "underlying done is terminal and propagates", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// An empty inner iterator (immediately done) yields no values, so the single
// outstanding call cannot be satisfied from it: the helper must pull the
// underlying again to find the next inner iterator. The consumer call only ever
// sees the value from the *second* iterator.
tests.push(scenarioTest({
  id: "flatmap-test-002",
  helper: "flatMap",
  label: "flatMap: an empty inner iterator triggers another underlying pull",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "mapper invoked for the first underlying value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "inner iterator A is pulled once", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    // A is empty: it reports done before yielding anything.
    { note: "the empty inner iterator forces another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a0", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "mapper invoked for the second underlying value", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "inner iterator B is pulled once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    { note: "the value from the second iterator satisfies the call", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
      { type: "result", result: "r0", value: "b0", from: "b0" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Demand coalescing + fan-out. Three concurrent next() calls cause a SINGLE
// underlying pull and a SINGLE mapper invocation; the resulting inner iterator is
// then pulled three times at once. With the inner pulls settled in order, the
// three values are delivered in call order.
tests.push(scenarioTest({
  id: "flatmap-test-003",
  helper: "flatMap",
  label: "flatMap: concurrent calls coalesce into one underlying pull and fan out to one inner iterator",
  ticks: [
    // Three concurrent calls, but only ONE underlying pull: the later two only
    // raised the demand count while the first was still being resolved.
    { note: "three concurrent calls cause a single underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // ONE mapper call for the one underlying value.
    { note: "a single mapper invocation", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The accumulated demand (3) fans out into three concurrent inner pulls.
    { note: "the inner iterator is pulled once per outstanding call", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
    ] } ] },
    { note: "the three inner values are delivered in call order", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "settle", pull: "a1", value: "a1" },
      { type: "settle", pull: "a2", value: "a2" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
      { type: "result", result: "r2", value: "a2", from: "a2" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Out-of-order settlement within a single inner iterator is reordered before
// delivery. Two concurrent inner pulls are in flight; the LATER one settles
// first, but it cannot be delivered ahead of the earlier (still-pending) one —
// each consumer call receives its own in-call-order value.
tests.push(scenarioTest({
  id: "flatmap-test-004",
  helper: "flatMap",
  label: "flatMap: out-of-order inner settlement is delivered in order",
  ticks: [
    { note: "two concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "mapper invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "two concurrent inner pulls", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // The second inner pull settles first; it must wait for the first.
    { note: "a later inner value cannot settle ahead of an earlier one", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
    ] } ] },
    { note: "once the earlier value arrives, both settle in call order", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// The scenario from the spec sketch. Four pulls; the first inner iterator (A)
// leaves two pulls in flight, then reports done — which immediately triggers
// another underlying pull whose mapper yields a second iterator (B), pulled twice.
// A's two still-in-flight pulls remain queued AHEAD of B's values, so even though
// a B value settles first, delivery order is a0, a1, b0, b1.
tests.push(scenarioTest({
  id: "flatmap-test-005",
  helper: "flatMap",
  label: "flatMap: inner done with earlier pulls still in flight queues them ahead of the next iterator",
  ticks: [
    { note: "four concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "next", result: "r3" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "one mapper invocation", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 4 fans out into four inner pulls", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
      { type: "inner-pull", pull: "a3", iterator: "A" },
    ] } ] },
    // A's first two pulls (#0, #1) stay in flight; pull #2 reports done. That
    // discards the tail (#2, #3) and redirects the freed demand (2) to a new
    // underlying pull. A's #0/#1 are not lost — they stay queued ahead.
    { note: "inner done redirects the freed demand to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a2", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the second underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // The redirected demand (2) fans out across B.
    { note: "the second inner iterator is pulled twice", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
    ] } ] },
    // B's first value settles, but A's values are still queued ahead of it.
    { note: "a later iterator value waits behind the earlier iterator", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
    ] } ] },
    // A's first value arrives -> r0.
    { note: "the earliest queued value is delivered", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    // A's second value arrives -> r1, which drains A and exposes B's buffered
    // b0 -> r2, all in one step.
    { note: "draining the first iterator lets the buffered later value through", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
      { type: "result", result: "r2", value: "b0", from: "b0" },
    ] } ] },
    { note: "the last value is delivered", steps: [ { events: [
      { type: "settle", pull: "b1", value: "b1" },
      { type: "result", result: "r3", value: "b1", from: "b1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// A terminal underlying done caps the trailing calls that can never be served,
// while an earlier inner value that is still in flight is NOT lost. Pull #1 of
// inner A reports done with pull #0 still pending, so A's #0 stays queued and the
// freed demand (2) goes to a fresh underlying pull; that underlying is then
// exhausted, so the two redirected calls settle done — but the call tied to A's
// still-pending #0 stays open and ultimately receives its value.
tests.push(scenarioTest({
  id: "flatmap-test-006",
  helper: "flatMap",
  label: "flatMap: a terminal underlying done caps trailing calls but keeps an in-flight inner value",
  ticks: [
    { note: "three concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "one mapper invocation", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 3 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
    ] } ] },
    // A's pull #0 stays pending; pull #1 reports done. The tail (#1, #2) is freed
    // (demand 2) and redirected; A's #0 remains queued ahead.
    { note: "the freed demand is redirected to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // The underlying is now exhausted. This terminal done caps the two redirected
    // calls (the last two in call order); the call still tied to A's pending #0 is
    // left open.
    { note: "the terminal done settles only the un-serviceable trailing calls", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    // A's still-in-flight #0 finally yields: its value is not lost.
    { note: "the earlier in-flight inner value still reaches its call", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// An inner iterator that reports done at its very first pull, with the full demand
// in flight, redirects ALL of it to a fresh underlying pull (no values queued
// ahead). A later settlement of one of the now-discarded inner pulls is harmless.
tests.push(scenarioTest({
  id: "flatmap-test-007",
  helper: "flatMap",
  label: "flatMap: a first-pull inner done redirects the whole demand; a late discarded pull is ignored",
  ticks: [
    { note: "two concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "one mapper invocation", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // A reports done at pull #0 while pull #1 is still in flight. With nothing
    // delivered, the entire demand (2) is redirected; A's #1 is discarded.
    { note: "the whole demand is redirected to a new underlying pull", steps: [ { events: [
      { type: "settle", pull: "a0", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "mapper invoked for the second underlying value", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "the second inner iterator absorbs the redirected demand", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
    ] } ] },
    { note: "both calls are satisfied from the second iterator", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
      { type: "settle", pull: "b1", value: "b1" },
      { type: "result", result: "r0", value: "b0", from: "b0" },
      { type: "result", result: "r1", value: "b1", from: "b1" },
    ] } ] },
    // The discarded inner pull (A's #1) settles late; it has no consumer effect.
    { note: "a late settlement of a discarded inner pull is ignored", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1-late" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// A deeper version of the queued-ahead case: three inner iterators each leave one
// earlier pull in flight when they report done, building a queue [A, B] ahead of
// the active iterator C. Everything settles out of order, yet the final delivery
// follows the concatenation order a0, b0, c0, c1.
tests.push(scenarioTest({
  id: "flatmap-test-008",
  helper: "flatMap",
  label: "flatMap: a chain of inner-done boundaries preserves cross-iterator order",
  ticks: [
    { note: "four concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "next", result: "r3" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "mapper invoked for the first value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 4 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
      { type: "inner-pull", pull: "a3", iterator: "A" },
    ] } ] },
    // A keeps #0 in flight and reports done at #1: A's #0 is queued; demand 3 is
    // redirected.
    { note: "A done redirects demand 3", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "mapper invoked for the second value", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "demand 3 fans out across B", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
      { type: "inner-pull", pull: "b2", iterator: "B" },
    ] } ] },
    // B keeps #0 in flight and reports done at #1: queue is now [A, B]; demand 2
    // is redirected.
    { note: "B done redirects demand 2", steps: [ { events: [
      { type: "settle", pull: "b1", done: true },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "mapper invoked for the third value", steps: [ { events: [
      { type: "settle", pull: "u2", value: 3 },
      { type: "fn", call: "p2", arg: 3, from: "u2" },
    ] } ] },
    { note: "demand 2 fans out across C", steps: [ { events: [
      { type: "fn-settle", call: "p2", iterator: "C" },
      { type: "inner-pull", pull: "c0", iterator: "C" },
      { type: "inner-pull", pull: "c1", iterator: "C" },
    ] } ] },
    // Settle everything out of order: the active iterator first, then B, then A.
    { note: "the active iterator values wait behind the queued iterators", steps: [ { events: [
      { type: "settle", pull: "c0", value: "c0" },
      { type: "settle", pull: "c1", value: "c1" },
    ] } ] },
    { note: "B still waits behind A", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
    ] } ] },
    // A's value arrives and the whole queue drains in concatenation order.
    { note: "the entire queue drains in order once the head arrives", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
      { type: "result", result: "r1", value: "b0", from: "b0" },
      { type: "result", result: "r2", value: "c0", from: "c0" },
      { type: "result", result: "r3", value: "c1", from: "c1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// An immediately-exhausted underlying: the very first pull reports done, so the
// stream is empty. The outstanding call settles done, and any later call is done
// too.
tests.push(scenarioTest({
  id: "flatmap-test-009",
  helper: "flatMap",
  label: "flatMap: an empty underlying is done immediately",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // The mapper is never invoked (no underlying value), and no source.return()
    // happens on clean exhaustion.
    { note: "an exhausted underlying settles the call done", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
    ] } ] },
    { note: "a later call is done as well", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// next() always returns a promise (never a bare result object), even once the
// helper has finished.
tests.push(scenarioTest({
  id: "flatmap-test-010",
  helper: "flatMap",
  label: "flatMap: next() returns a promise",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the call settles done", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
    ] } ] },
    { note: "the settled call resolves done", steps: [ { events: [
      { type: "next", result: "rDone" },
      { type: "result", result: "rDone", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

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
tests.push(scenarioTest({
  id: "flatmap-test-011",
  helper: "flatMap",
  label: "flatMap: an error from the underlying iterator does not close it",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // No `src.return()`: the underlying error is surfaced without closing.
    { note: "underlying error rejects, source left open", steps: [ { events: [
      { type: "settle", pull: "u0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "a subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// A synchronous throw from the mapper closes the underlying (like a map/filter
// predicate throw) and the result rejects.
tests.push(scenarioTest({
  id: "flatmap-test-012",
  helper: "flatMap",
  label: "flatMap: a synchronous throw from the mapper closes the underlying iterator",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "fn-sync", arg: 1, error: "boom" },
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper throw closes the source, then rejects", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "a subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// An asynchronous mapper rejection behaves the same as a synchronous throw: it
// closes the underlying and the result rejects.
tests.push(scenarioTest({
  id: "flatmap-test-013",
  helper: "flatMap",
  label: "flatMap: an async mapper rejection closes the underlying iterator",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the mapper rejection closes the source, then rejects", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "a subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// An error from an inner (result) iterator's `.next()` closes the UNDERLYING
// (but not the erroring inner iterator, which a rejected next has exhausted), and
// the result rejects.
tests.push(scenarioTest({
  id: "flatmap-test-014",
  helper: "flatMap",
  label: "flatMap: an error from an inner iterator closes the underlying iterator",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the inner iterator is pulled", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    // The inner iterator's pull rejects. That closes the underlying (only — not the
    // already-exhausted inner iterator), then the rejection surfaces.
    { note: "the inner error closes the underlying, then rejects", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "a subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: helper called with a hand-rolled source
//   reason: threw during recording: Cannot read properties of undefined (reading 'resolve')
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
tests.push(scenarioTest({
  id: "flatmap-test-016",
  helper: "flatMap",
  label: "flatMap: a later inner error does not lose an earlier in-flight inner value",
  ticks: [
    { note: "two concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "two concurrent inner pulls", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // The later inner pull (#1) errors first. It closes the underlying, but it sits
    // behind the still-pending pull #0, so nothing is surfaced yet.
    { note: "the later inner error closes the source but waits behind the earlier pull", steps: [ { events: [
      { type: "settle", pull: "a1", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    // Pull #0 yields: its value reaches r0 (not lost), then the error reaches r1.
    { note: "the earlier value is delivered, then the error reaches the later call", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// An inner iterator errors *while we are already reading the underlying for the
// next iterator*. That earlier inner error closes the stream, but unlike a
// straightforward inner error (test 014/016) there is an in-flight underlying
// pull — and the iterator IT is about to produce — that must still be closed
// before the error is surfaced. This is the error-driven twin of the "return()
// while reading the underlying" dance (test 018): no result.return() is in
// flight, so the held position is the error slot itself. Concretely, A keeps
// pull #0 in flight and reports done at #1, redirecting demand 2 to a fresh
// underlying pull (u1); then A's #0 rejects. We must wait for u1 (and the inner
// iterator B it produces) and close BOTH B and the underlying, in order, before
// the error reaches r0.
tests.push(scenarioTest({
  id: "flatmap-test-064",
  helper: "flatMap",
  label: "flatMap: an earlier inner error while reading the underlying still closes the produced iterator and the underlying",
  ticks: [
    { note: "three concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 3 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
    ] } ] },
    // A keeps #0 in flight and reports done at #1: A's #0 is queued ahead; the
    // freed demand (2) is redirected to a fresh underlying pull. We are now
    // reading the underlying for the next iterator.
    { note: "inner done redirects the freed demand to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // A's still-in-flight #0 now ERRORS. This closes the stream, but the
    // underlying pull (u1) is in flight: nothing is closed yet. The two
    // redirected trailing calls (r1, r2) can never get a value -> done eagerly.
    // r0 (tied to A's #0) is held for the error.
    { note: "the earlier inner error dones the trailing calls but defers the closes", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "result", result: "r1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    // The in-flight underlying value is still mapped — we must close whatever it
    // produces.
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // The produced iterator B is closed without being pulled (it was never
    // pulled, so there is no .return()-after-done hazard).
    { note: "the produced iterator is closed without being pulled", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "close", target: "B" },
    ] } ] },
    // Closes are sequential: the underlying is closed only once B's close settles.
    { note: "once the inner close settles, the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    // Only once the underlying close settles does the error reach the held call.
    { note: "once the underlying close settles, the error reaches the held call", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

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
tests.push(scenarioTest({
  id: "flatmap-test-017",
  helper: "flatMap",
  label: "flatMap: return() before starting closes the underlying without pulling",
  ticks: [
    // No src.next() (nothing was ever pulled), but the underlying is still closed.
    { note: "return() closes the underlying without pulling, then resolves done", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "a next() after return() is done", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "result", result: "r0", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- return() while reading the underlying (the "less-eager pull" model) -----
//
// When return() lands while a pull from the underlying is in flight (no inner
// iterator yet), we are committed to closing, so we will NOT pull the iterator that
// pull is about to produce. NOTHING is closed at return() time: the closes are
// deferred until the in-flight pull and mapper settle, because they might
// throw/reject — a stream error that must reach a consumer call.
//
//   * The `requested` units of demand bound to that pull can never receive a value
//     (we won't pull), so the trailing `requested - 1` "surplus" calls are doned
//     {done:true} EAGERLY at return(). The head-most bound call is HELD: it is the
//     position a pull/mapper rejection would be delivered to (queued behind any
//     parked values, like a normal underlying error).
//   * When the in-flight pull/mapper settle:
//       - pull dones     -> the underlying exhausted itself; a clean done does not
//                           close the source, so nothing is closed and return()
//                           resolves done.
//       - pull rejects   -> the underlying faulted itself, so nothing is closed; the
//                           rejection (the stream's error) goes to the held call and
//                           return() resolves done.
//       - mapper rejects -> the underlying is closed NOW; the mapper error goes to
//                           the held call once that close settles, and return()
//                           settles from the close's outcome.
//       - value+iterable -> invoke the iterable and call .return() on it RIGHT AWAY
//                           (no .next()); the held call dones. Only once the inner
//                           close settles is the underlying closed — the same
//                           sequential inner-then-underlying order as the
//                           active-iterator return path — and return() settles with
//                           the outcome (a close error rejects it, the inner's
//                           taking precedence).
//     The stream error from a pull/mapper rejection goes to the held call, never to
//     return()'s promise.
// The base success case: a single outstanding call. Nothing closes at return(); the
// produced iterator is closed without being pulled and the held call dones; the
// underlying closes after the inner close settles; return() then resolves.
tests.push(scenarioTest({
  id: "flatmap-test-018",
  helper: "flatMap",
  label: "flatMap: return() while reading the underlying closes the produced iterator without pulling it",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // return() while reading underlying. Nothing closes yet; r0 is held in case the
    // pull/mapper rejects.
    { note: "return() defers the closes; the call is held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    // The pull resolves with a value; the mapper is invoked.
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The mapper resolves to an iterable: invoke it and call .return() RIGHT AWAY (no
    // .next()). The held call can never get a value now, so it dones.
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "close", target: "A" },
      { type: "result", result: "r0", done: true },
    ] } ] },
    // The closes are sequential: the underlying's .return() is invoked only once the
    // inner close settles.
    { note: "once the inner close settles, the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the underlying close settles, return() resolves", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// With more than one bound call, the trailing surplus is doned EAGERLY at return()
// time (it can never get a value), while the head-most bound call is held.
tests.push(scenarioTest({
  id: "flatmap-test-019",
  helper: "flatMap",
  label: "flatMap: return() while reading the underlying dones the surplus eagerly and holds the head call",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // Demand 2; we won't pull, so the trailing call (r1) can never get a value -> done
    // it eagerly. The head call (r0) is held; nothing closes yet.
    { note: "the surplus dones eagerly; the head is held", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "close", target: "A" },
      { type: "result", result: "r0", done: true },
    ] } ] },
    { note: "once the inner close settles, the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the underlying close settles, return() resolves", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// The in-flight pull REJECTS after return(). The rejection is the stream's and goes
// to the held call. The underlying faulted itself, so nothing is closed at all and
// return() resolves right away.
tests.push(scenarioTest({
  id: "flatmap-test-020",
  helper: "flatMap",
  label: "flatMap: return() while reading the underlying surfaces an underlying-pull rejection to the held call",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "return() defers the closes; the call is held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    { note: "the pull error reaches the held call; return() resolves, closing nothing", steps: [ { events: [
      { type: "settle", pull: "u0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// The MAPPER rejects after return(). The underlying produced a value and is still
// open, so it is closed NOW; the mapper error is the stream's, withheld until that
// close settles, then delivered to the held call. No inner is produced.
tests.push(scenarioTest({
  id: "flatmap-test-021",
  helper: "flatMap",
  label: "flatMap: return() while reading the underlying, then the mapper rejects, surfaces the error to the held call",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "return() defers the closes; the call is held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the mapper error closes the underlying; the error is withheld until that settles", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the close settles, the error reaches the held call and return() resolves", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// CLOSE error on the success path: the produced iterator's .return() rejects. The
// underlying is still closed afterwards, and return() rejects with the inner-close
// error (inner taking precedence over the underlying).
tests.push(scenarioTest({
  id: "flatmap-test-022",
  helper: "flatMap",
  label: "flatMap: return() while reading the underlying rejects with the inner-close error when the produced .return() rejects",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "return() defers the closes; the call is held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "close", target: "A" },
      { type: "result", result: "r0", done: true },
    ] } ] },
    // The inner .return() rejects; the underlying is still closed afterwards.
    { note: "the inner close rejected; the underlying still closes", steps: [ { events: [
      { type: "close-settled", target: "A", error: "inner-close" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the underlying close settles, return() rejects with the inner-close error", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", error: "inner-close" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// return() while an inner iterator is active (and quiescent — its one delivered
// value left no pull in flight) closes BOTH the inner iterator and the
// underlying, in that order, and resolves done. A second return() is a no-op.
tests.push(scenarioTest({
  id: "flatmap-test-023",
  helper: "flatMap",
  label: "flatMap: return() closes the active inner iterator and the underlying, and is idempotent",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the inner iterator is pulled", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    // Deliver the one value so the active iterator has no pull in flight.
    { note: "the value is delivered, leaving the inner iterator active but idle", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    // The active inner iterator is closed first, then the underlying.
    { note: "return() closes the inner iterator then the underlying", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "A" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "a second return() closes nothing again", steps: [ { events: [
      { type: "return", result: "ret2" },
      { type: "result", result: "ret2", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// return() after the underlying has cleanly finished must not close it.
tests.push(scenarioTest({
  id: "flatmap-test-024",
  helper: "flatMap",
  label: "flatMap: return() after a clean done does not close the source",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the underlying is exhausted", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
    ] } ] },
    // No src.return(): a finished source is not closed again.
    { note: "return() after a clean done does not close the source", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// return() after the underlying has errored must not close it.
tests.push(scenarioTest({
  id: "flatmap-test-025",
  helper: "flatMap",
  label: "flatMap: return() after an underlying error does not close the source",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the underlying error rejects the call", steps: [ { events: [
      { type: "settle", pull: "u0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    // No src.return(): the source faulted, so it is not closed.
    { note: "return() after an underlying error does not close the source", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// return() means "no more demand", but — as in map/filter — it does NOT cancel
// values that were already requested. Pulls already in flight on the active inner
// iterator when return() lands still deliver their values; closing the inner
// iterator (.return()) does not discard its outstanding .next() results.
tests.push(scenarioTest({
  id: "flatmap-test-026",
  helper: "flatMap",
  label: "flatMap: return() still delivers values already requested from the active inner iterator",
  ticks: [
    { note: "two concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "two inner pulls are in flight", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // return() closes the inner iterator and the underlying, but the two in-flight
    // inner pulls are NOT cancelled.
    { note: "return() closes both iterators without settling the in-flight calls", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "A" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    // The already-requested values still arrive, in call order.
    { note: "the first already-requested value is delivered", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    { note: "the second already-requested value is delivered", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
    { note: "a call made after return() is done", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "result", result: "r2", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// The in-order delivery guarantee survives return(): an already-requested value
// that settles out of order still waits for the earlier one.
tests.push(scenarioTest({
  id: "flatmap-test-027",
  helper: "flatMap",
  label: "flatMap: after return(), already-requested values are still delivered in order",
  ticks: [
    { note: "two concurrent calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "two inner pulls are in flight", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "return() closes both iterators", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "A" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    // The second pull settles first; it must still wait for the first.
    { note: "a later value cannot settle ahead of the earlier one", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
    ] } ] },
    { note: "both already-requested values settle in call order", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- Terminal events with coalesced demand / after return() ----------------
// A mapper error coalesced across several calls: while "reading underlying",
// concurrent calls share one underlying pull and one mapper invocation. When the
// mapper fails it closes the underlying, the first position takes the error (after
// the close settles), and the other coalesced calls — which can never be filled
// now the source is closing — settle done. (filter's terminal-error shape.)
tests.push(scenarioTest({
  id: "flatmap-test-028",
  helper: "flatMap",
  label: "flatMap: a mapper error with coalesced demand rejects one call and dones the surplus",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "a single mapper invocation", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The done settles immediately (the source is closing, so the surplus call can
    // never be filled); the error waits for src.return() to settle.
    { note: "the surplus call is done, then the error reaches the first call", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// After return(), an already-requested inner pull that *errors* (instead of
// yielding) must still reach its call. Everything is already closed, so the error
// is surfaced directly with no further close.
tests.push(scenarioTest({
  id: "flatmap-test-029",
  helper: "flatMap",
  label: "flatMap: after return(), an inner error still reaches its already-requested call",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the inner iterator is pulled", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    { note: "return() closes both iterators", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "A" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    // The already-requested pull rejects; the error reaches its call (no new close).
    { note: "the in-flight error reaches its call", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// After return(), an inner iterator that reports done settles only as many calls
// as it had outstanding — NOT every call behind it — because a later inner
// iterator's already-requested values still deliver, shifting forward to fill in.
tests.push(scenarioTest({
  id: "flatmap-test-030",
  helper: "flatMap",
  label: "flatMap: after return(), an inner done settles only its own outstanding calls; later values still deliver",
  ticks: [
    { note: "four coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "next", result: "r3" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 4 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
      { type: "inner-pull", pull: "a3", iterator: "A" },
    ] } ] },
    // A reports done at pull #2 (pulls #0/#1 still in flight): it keeps [a0, a1] and
    // the freed demand (2) redirects to a second underlying pull -> iterator B.
    { note: "A done redirects the freed demand to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a2", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "demand 2 fans out across B", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
    ] } ] },
    // The flattened stream now stands at [a0, a1, b0, b1]. return() closes the
    // active iterator B and the underlying; A (already queued) and B keep their
    // in-flight pulls for delivery.
    { note: "return() closes the active inner iterator and the underlying", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "B" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    // A reports done at its second outstanding pull (#1), with #0 still pending.
    // That ends A one value short, so the stream shrinks to [a0, b0, b1]: exactly
    // ONE call (the surplus tail, r3) settles done — not r1/r2, which B still feeds.
    { note: "only the single surplus call settles done", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "result", result: "r3", done: true },
    ] } ] },
    // The survivors deliver in concatenation order; B's values shift forward.
    { note: "A's surviving value goes to the first call", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    { note: "the later iterator value shifts forward to the next call", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
      { type: "result", result: "r1", value: "b0", from: "b0" },
    ] } ] },
    { note: "and the last survivor to the call after it", steps: [ { events: [
      { type: "settle", pull: "b1", value: "b1" },
      { type: "result", result: "r2", value: "b1", from: "b1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

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
tests.push(scenarioTest({
  id: "flatmap-test-031",
  helper: "flatMap",
  label: "flatMap: a mid-stream inner error closes the active iterator then the underlying, sequentially",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // A reports done at pull #1 with pull #0 still in flight: A is parked in the
    // closed queue (keeping #0), and the freed demand (1) redirects to a new
    // underlying pull -> iterator B.
    { note: "A done redirects the freed demand to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "the redirected demand pulls the live inner B", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    // Hold both .return()s so we can observe their ordering and confirm the
    // rejection is withheld until both settle.
    // A's lingering pull #0 rejects. B is the live active iterator, so it is closed
    // FIRST; the underlying is not touched yet, and nothing is surfaced. B's
    // already-requested pull #0 is NOT discarded (the error stops new pulls, not
    // already-issued ones): it stays bound to r1.
    { note: "the active inner iterator is closed first, alone", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "close", target: "B" },
    ] } ] },
    // Once B's close settles, the underlying is closed next — still no rejection.
    { note: "only then is the underlying closed", steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    // Only after BOTH closes settle does the error reach the call scanning into A.
    { note: "the rejection surfaces after both closes settle", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    // B's already-requested pull settles after the close: its value still reaches
    // r1, exactly as an in-flight pull survives an explicit return().
    { note: "the already-requested inner value still reaches its call", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
      { type: "result", result: "r1", value: "b0", from: "b0" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: mapper resolved with a non-controlled inner iterator
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
tests.push(scenarioTest({
  id: "flatmap-test-033",
  helper: "flatMap",
  label: "flatMap: an inner error still delivers a later already-issued pull on the same iterator",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across the active iterator", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // A's earlier pull (#0) rejects while pull #1 is still in flight. #0 is the head,
    // so it closes the underlying and its error is committed to r0 (surfacing once
    // src.return() settles). Pull #1 was already issued, so it stays bound to r1.
    { note: "the underlying closes, then the error reaches the first call", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    // A's already-issued pull #1 settles after the error: its value still reaches r1.
    { note: "the already-requested inner value still reaches its call", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Underlying-error path with buffered values ahead of the error. An earlier inner
// iterator is parked with in-flight pulls (buffered, ahead in the stream) when the
// underlying errors fetching the NEXT iterator. The buffered values must still
// deliver, the error must reach the call at that position, and any surplus is
// doned — the error must NOT be swallowed into a clean done.
tests.push(scenarioTest({
  id: "flatmap-test-034",
  helper: "flatMap",
  label: "flatMap: an underlying error behind buffered values still surfaces after them",
  ticks: [
    { note: "three coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 3 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
    ] } ] },
    // A reports done at pull #2 with #0/#1 still in flight: A is parked keeping
    // [a0, a1], and the freed demand (1) redirects to a second underlying pull.
    { note: "A done redirects the freed demand to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a2", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // The underlying errors fetching the next iterator. It is NOT closed (it errored
    // itself), and nothing surfaces yet: the error sits behind A's buffered values.
    { note: "the underlying error is buffered behind the parked values", steps: [ { events: [
      { type: "settle", pull: "u1", error: "boom" },
    ] } ] },
    // A's buffered values deliver in order; draining A then exposes the error to the
    // call at that position.
    { note: "the first buffered value is delivered", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    { note: "the last buffered value is delivered, then the error surfaces", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
      { type: "result", result: "r2", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- bookkeeping when an earlier pull is delivered before a later one settles --
// The active iterator yields an early value (which is delivered and shifts off the
// queue) and only THEN does a later pull of the same iterator report done. The
// freed demand must still redirect to a fresh underlying pull, so the trailing
// call is satisfied by the next iterator — it must not be left hanging.
tests.push(scenarioTest({
  id: "flatmap-test-035",
  helper: "flatMap",
  label: "flatMap: a delivered early value does not corrupt a later same-iterator done",
  ticks: [
    { note: "three coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 3 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
    ] } ] },
    // Deliver A's first value: it is dispatched and shifts off the head of the queue.
    { note: "the first value is delivered", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    // Now A's LAST pull (#2) reports done while #1 is still in flight. A keeps [a1]
    // and the freed demand (1, for r2) redirects to a fresh underlying pull.
    { note: "the freed demand redirects to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a2", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the second value is delivered", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
    { note: "the second underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "the redirected demand pulls the second iterator once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    { note: "the trailing call is satisfied by the next iterator", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
      { type: "result", result: "r2", value: "b0", from: "b0" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// A pull of an ALREADY-PARKED iterator rejects while the helper is between inner
// iterators (reading the underlying for the next one). The error belongs to the
// parked iterator's position and will close the underlying and reach that call;
// the demand that was coalesced for the NEXT iterator sits after the error and can
// never be filled, so those calls settle done. But the in-flight underlying pull
// might still produce an iterator that has to be closed, so — like return() while
// reading the underlying — nothing closes until that pull settles. Here it settles
// DONE: the underlying exhausted itself, so nothing is closed at all (see test 047
// for the mapper-reject completion and test 064 for the value/iterator one).
tests.push(scenarioTest({
  id: "flatmap-test-036",
  helper: "flatMap",
  label: "flatMap: a parked-iterator pull error while reading underlying defers the close and dones the pending demand",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // A reports done at pull #1 with pull #0 still in flight: A is parked keeping #0,
    // and the freed demand (1, aimed at the NEXT iterator) reads the underlying again.
    { note: "A done redirects the freed demand to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // A's parked pull #0 now rejects while the underlying pull (u1) is in flight.
    // We are committed to closing, but nothing is closed yet — that pull might
    // produce an iterator to close. The pending demand for the next iterator (r1)
    // can never be filled -> done eagerly; r0 (tied to A's #0) is held.
    { note: "the parked-iterator error dones the pending demand but defers the close", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "result", result: "r1", done: true },
    ] } ] },
    // The in-flight underlying pull reports done: a clean done does not close the
    // source, and there is no iterator to close, so nothing is closed at all and
    // A's error surfaces to r0.
    { note: "the underlying exhausts itself: nothing to close, the error surfaces", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// A later iterator's value settles while it is still queued behind an earlier
// parked iterator (so it is buffered, not delivered). When that parked iterator is
// then exhausted, the buffered value becomes the head of the queue and must be
// flushed to its call — removing the parked iterator cannot leave it stranded.
tests.push(scenarioTest({
  id: "flatmap-test-037",
  helper: "flatMap",
  label: "flatMap: exhausting a parked iterator flushes a value already buffered behind it",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // A reports done at pull #1 with pull #0 still in flight: A is parked keeping #0,
    // and the freed demand (1) redirects to a fresh underlying pull -> iterator B.
    { note: "A done redirects the freed demand to another underlying pull", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the second underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "the redirected demand pulls B once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    // B's value settles, but it sits behind A's still-pending pull #0, so it waits.
    { note: "the later value is buffered behind the parked iterator", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
    ] } ] },
    // A's pull #0 now reports done, exhausting A entirely. b0 becomes the head and
    // must flush to r0; the freed demand redirects to a fresh pull of B.
    { note: "exhausting the parked iterator flushes the buffered value", steps: [ { events: [
      { type: "settle", pull: "a0", done: true },
      { type: "inner-pull", pull: "b1", iterator: "B" },
      { type: "result", result: "r0", value: "b0", from: "b0" },
    ] } ] },
    { note: "the next value is delivered too", steps: [ { events: [
      { type: "settle", pull: "b1", value: "b1" },
      { type: "result", result: "r1", value: "b1", from: "b1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Same flush hazard, but the parked iterator is exhausted while the helper is
// READING THE UNDERLYING (not while another iterator is active). Two iterators are
// parked; the second already has a buffered value; exhausting the first must flush
// that value even though the active state is "reading underlying".
tests.push(scenarioTest({
  id: "flatmap-test-038",
  helper: "flatMap",
  label: "flatMap: exhausting a parked iterator while reading underlying flushes a buffered value",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // Iterator A: pulled twice, reports done on #1 -> parked keeping #0 in flight.
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Iterator B becomes active; a third call gives it a second pull so it too can be
    // parked, with its first value buffered behind A.
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "B is pulled once for the outstanding call", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    { note: "a third call gives B a second pull", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
    ] } ] },
    // B reports done on #1 -> parked keeping #0 in flight; freed demand reads the
    // underlying again. Now BOTH A and B are parked, and the helper is reading.
    { note: "B parks; freed demand reads the underlying again", steps: [ { events: [
      { type: "settle", pull: "b1", done: true },
      { type: "pull", pull: "u2" },
    ] } ] },
    // B's pull #0 settles, but it sits behind A, so it is buffered, not delivered.
    { note: "B0 is buffered behind A", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
    ] } ] },
    // A is exhausted (its only remaining pull reports done) while reading underlying.
    // b0 becomes the head and must flush to r0.
    { note: "exhausting A flushes the value buffered behind it", steps: [ { events: [
      { type: "settle", pull: "a0", done: true },
      { type: "result", result: "r0", value: "b0", from: "b0" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Same flush hazard once the helper is FINISHED (here via return()): a value is
// buffered in a parked iterator behind another parked iterator; exhausting the
// front one must flush that buffered value, even though no more pulls will happen.
tests.push(scenarioTest({
  id: "flatmap-test-039",
  helper: "flatMap",
  label: "flatMap: exhausting a parked iterator after return() flushes a buffered value",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // A: pulled twice, done on #1 -> parked keeping #0 in flight.
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "B is pulled once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    // A third call gives B a second in-flight pull (so both calls are bound to it).
    { note: "a third call gives B a second pull", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
    ] } ] },
    // B's first value settles, buffered behind A's still-pending pull #0.
    { note: "B0 is buffered behind A", steps: [ { events: [
      { type: "settle", pull: "b0", value: "B0" },
    ] } ] },
    // return() closes B and the underlying; already-requested pulls stay deliverable.
    { note: "return() closes the active iterator and the underlying", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "B" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    // A's last pull reports done, exhausting A while the helper is already finished.
    // A contributed nothing, so its surplus call is doned and B0 flushes forward.
    { note: "exhausting A dones the surplus and flushes the buffered value", steps: [ { events: [
      { type: "settle", pull: "a0", done: true },
      { type: "result", result: "r2", done: true },
      { type: "result", result: "r0", value: "B0", from: "b0" },
    ] } ] },
    { note: "the remaining buffered value is delivered", steps: [ { events: [
      { type: "settle", pull: "b1", value: "B1" },
      { type: "result", result: "r1", value: "B1", from: "b1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

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
tests.push(scenarioTest({
  id: "flatmap-test-040",
  helper: "flatMap",
  label: "flatMap: a next() during the mapper-pending window coalesces onto the same inner iterator",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked, now pending", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // This call lands while the mapper is still pending. It must NOT pull the
    // underlying again or invoke the mapper again — it only raises demand.
    { note: "a next() while the mapper is pending neither pulls nor maps again", steps: [ { events: [
      { type: "next", result: "r1" },
    ] } ] },
    // Demand accumulated to 2 across the pending window, so A fans out twice.
    { note: "the accumulated demand fans out onto the single inner iterator", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "both values are delivered in call order", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "settle", pull: "a1", value: "a1" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: mapper resolved with a non-controlled inner iterator
//   reason: t.check assertion: the call rejects with a TypeError
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
  // Obtaining the inner iterator throws synchronously; that closes the source.
  t.expectLog('obtaining the inner iterator fails, closing the source', ['src.return() #0']);

  // The rejection only surfaces once the close settles.
  src.settleReturn(0);
  await flushMicrotasks();
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
tests.push(scenarioTest({
  id: "flatmap-test-042",
  helper: "flatMap",
  label: "flatMap: a non-head pull of the active iterator errors behind a still-pending earlier pull",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across the active iterator", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // The LATER pull (#1) rejects while the head pull (#0) is still in flight. The
    // underlying closes, but the error sits behind #0, so nothing surfaces yet.
    { note: "the source closes but the error waits behind the earlier pull", steps: [ { events: [
      { type: "settle", pull: "a1", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    // The head pull yields: its value reaches r0, then the queued error reaches r1.
    { note: "the earlier value is delivered, then the error reaches the later call", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- two concurrent inner pulls that BOTH error -----------------------------
//
// Two concurrent pulls of the same active inner iterator are in flight; both
// reject. An error is not a wall that swallows later already-issued pulls: each
// pull delivers its own result in order, so BOTH errors surface (r0 then r1).
// (Settling a later in-flight pull done instead would be wrong: if a *third*
// pull had yielded a value, a done at r1 would sit ahead of that real value.)
tests.push(scenarioTest({
  id: "flatmap-test-043",
  helper: "flatMap",
  label: "flatMap: two concurrent inner pulls that both reject surface both errors in order",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across the active iterator", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // The head pull rejects: it closes the underlying and its error reaches r0.
    { note: "the head error closes the underlying, then reaches the first call", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom0" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom0" },
    ] } ] },
    // The second already-issued pull also rejects: its error reaches r1 (not a done).
    { note: "the second already-issued error reaches the second call", steps: [ { events: [
      { type: "settle", pull: "a1", error: "boom1" },
      { type: "result", result: "r1", error: "boom1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Same as above but the pulls reject in the OTHER order: the LATER pull (#1)
// rejects first (it is the active iterator's error, so it closes the underlying)
// but sits behind the still-pending head pull. When the head pull then rejects,
// both errors drain in call order, each call getting its own pull's error.
tests.push(scenarioTest({
  id: "flatmap-test-044",
  helper: "flatMap",
  label: "flatMap: two concurrent inner pulls that both reject (later first) still surface both in order",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across the active iterator", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // The later pull rejects first: closes the underlying, but waits behind #0.
    { note: "the later error closes the underlying but waits behind the head pull", steps: [ { events: [
      { type: "settle", pull: "a1", error: "boom1" },
      { type: "close", target: "source" },
    ] } ] },
    // The head pull rejects: both errors drain in call order.
    { note: "both errors drain in call order", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom0" },
      { type: "result", result: "r0", error: "boom0" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boom1" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Errors from DIFFERENT inner iterators. A reports done with pull #0 still in
// flight (parked, feeding r0); the freed demand yields a live iterator B (its
// pull #0 feeds r1). A's parked pull rejects FIRST while B is still live: the
// active iterator B is closed first, then the underlying, then A's error reaches
// r0. B's already-issued pull then rejects and reaches r1.
tests.push(scenarioTest({
  id: "flatmap-test-045",
  helper: "flatMap",
  label: "flatMap: errors from two different inner iterators (parked first) surface both in order",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks keeping pull #0; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "the live inner B is pulled once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    // A's parked pull rejects while B is live: close active B first, then the
    // underlying, then A's error reaches r0.
    { note: "the active iterator and underlying are closed, then A errors to r0", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boomA" },
      { type: "close", target: "B" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boomA" },
    ] } ] },
    // B's already-issued pull rejects and reaches r1 (no further close).
    { note: "B errors to the second call", steps: [ { events: [
      { type: "settle", pull: "b0", error: "boomB" },
      { type: "result", result: "r1", error: "boomB" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Same two-iterator setup, OTHER order: the live iterator B rejects FIRST. B is
// exhausted by its own error and A is already done, so only the underlying is
// closed (no B.return()). The error waits behind A's still-pending parked pull;
// when A then rejects, both errors drain in call order: r0 <- A, r1 <- B.
tests.push(scenarioTest({
  id: "flatmap-test-046",
  helper: "flatMap",
  label: "flatMap: errors from two different inner iterators (active first) surface both in order",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks keeping pull #0; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "the live inner B is pulled once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    // B (the live active iterator) rejects first: exhausted by its own error, and A
    // is already done, so only the underlying is closed. The error waits behind A.
    { note: "only the underlying is closed; nothing surfaces yet", steps: [ { events: [
      { type: "settle", pull: "b0", error: "boomB" },
      { type: "close", target: "source" },
    ] } ] },
    // A's parked pull rejects: both errors drain in call order.
    { note: "both errors drain in call order", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boomA" },
      { type: "result", result: "r0", error: "boomA" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boomB" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// One error from an inner iterator, one from the mapper. A is parked with pull #0
// in flight (feeding r0); the freed demand is mid-mapper for the NEXT iterator
// (feeding r1). The parked inner rejects FIRST: A owns the stream and the pending
// demand (r1) is doned, but the close is DEFERRED until the in-flight mapper
// settles (it might produce an iterator to close). The mapper then rejects: that
// faults the underlying, so it is closed — A's error, not the mapper's, surfaces
// to r0 once the close settles. (The mapper-completion twin of test 036's
// underlying-done and test 064's value/iterator completions.)
tests.push(scenarioTest({
  id: "flatmap-test-047",
  helper: "flatMap",
  label: "flatMap: an inner error then a mapper error (inner first) closes via the mapper rejection and surfaces the inner error",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks keeping pull #0; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again, now pending", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // A's parked pull rejects while the mapper is pending. A owns the stream; the
    // pending demand (r1) is doned, but nothing closes yet — we must let the mapper
    // settle first. r0 (tied to A's #0) is held.
    { note: "the parked-iterator error dones the pending demand but defers the close", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boomA" },
      { type: "result", result: "r1", done: true },
    ] } ] },
    // The mapper now rejects. It produced no iterator, but a mapper fault closes the
    // underlying; the mapper's own error (boomM) is swallowed since A already owns
    // the stream.
    { note: "the mapper rejection closes the underlying; its own error is swallowed", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boomM" },
      { type: "close", target: "source" },
    ] } ] },
    // Only once the underlying close settles does A's error reach r0.
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boomA" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// TODO it is kind of weird that this is observably different than previous case.
// Maybe that'll be fixed if/when we start waiting for mapper results.
// Same setup, OTHER order: the mapper rejects FIRST. While "reading underlying"
// the mapper error closes the underlying and takes the position the next iterator
// would have filled (r1), but waits behind A's still-pending parked pull. When A
// then rejects, both errors drain in call order: r0 <- A's inner error, r1 <- the
// mapper error.
tests.push(scenarioTest({
  id: "flatmap-test-048",
  helper: "flatMap",
  label: "flatMap: a mapper error then an inner error (mapper first) surfaces both in order",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks keeping pull #0; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again, now pending", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // The mapper rejects first: it closes the underlying and takes r1's position,
    // but waits behind A's still-pending parked pull.
    { note: "the mapper error closes the underlying but waits behind the parked pull", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boomM" },
      { type: "close", target: "source" },
    ] } ] },
    // A's parked pull rejects: both errors drain in call order.
    { note: "both errors drain in call order", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boomA" },
      { type: "result", result: "r0", error: "boomA" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boomM" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- multiple parked iterators + a clean underlying done --------------------
//
// Two iterators are parked (each keeping one in-flight pull) when the underlying
// is cleanly exhausted while reading for the next one. The terminal done caps only
// the un-serviceable surplus (one call), and the two buffered values then drain in
// concatenation order across the two closed-queue entries.
tests.push(scenarioTest({
  id: "flatmap-test-049",
  helper: "flatMap",
  label: "flatMap: a clean underlying done with two parked iterators caps the surplus and drains both",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // A: pulled twice, done on #1 -> parked keeping #0 in flight.
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "B is pulled once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    // A third call gives B a second pull so B too can be parked.
    { note: "a third call gives B a second pull", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
    ] } ] },
    { note: "B parks; freed demand reads the underlying again", steps: [ { events: [
      { type: "settle", pull: "b1", done: true },
      { type: "pull", pull: "u2" },
    ] } ] },
    // The underlying is now cleanly exhausted while both A and B are parked. The
    // stream is [a0, b0] plus the surplus call r2, which can never be filled.
    { note: "the terminal done caps only the surplus call (no source.return on a clean done)", steps: [ { events: [
      { type: "settle", pull: "u2", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    // The two buffered values now drain in order across the two closed-queue entries.
    { note: "the first parked value is delivered", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    { note: "the second parked value is delivered", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
      { type: "result", result: "r1", value: "b0", from: "b0" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- an underlying error behind TWO parked iterators ------------------------
//
// The existing underlying-error-behind-buffered-values test parks a single
// iterator. This parks two: the error (fetching the third iterator) must keep one
// call for itself and one per buffered value, drain both parked entries in order,
// and only then surface — across MULTIPLE closed-queue entries.
tests.push(scenarioTest({
  id: "flatmap-test-050",
  helper: "flatMap",
  label: "flatMap: an underlying error behind two parked iterators drains both then surfaces",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks; freed demand reads the underlying", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the mapper is invoked again", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "B is pulled once", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "inner-pull", pull: "b0", iterator: "B" },
    ] } ] },
    { note: "a third call gives B a second pull", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "inner-pull", pull: "b1", iterator: "B" },
    ] } ] },
    { note: "B parks; freed demand reads the underlying again", steps: [ { events: [
      { type: "settle", pull: "b1", done: true },
      { type: "pull", pull: "u2" },
    ] } ] },
    // The underlying errors fetching the third iterator. It is NOT closed; the error
    // sits behind A's and B's buffered values, keeping exactly one call for itself.
    { note: "the underlying error is buffered behind both parked iterators", steps: [ { events: [
      { type: "settle", pull: "u2", error: "boom" },
    ] } ] },
    { note: "the first parked value is delivered", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    // Draining B exposes the error to the call at its position.
    { note: "the second parked value is delivered, then the error surfaces", steps: [ { events: [
      { type: "settle", pull: "b0", value: "b0" },
      { type: "result", result: "r1", value: "b0", from: "b0" },
      { type: "result", result: "r2", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- close failures: a .return() that throws/rejects ------------------------
//
// As in map/filter, a consumer return() propagates a close failure to its own
// result (after still attempting the other close), while a close failure during
// ERROR-driven cleanup is swallowed (the original stream error wins). And an
// iterator with no .return() method at all must be tolerated.
// return() closes the active inner first; if THAT close throws synchronously, the
// underlying is still closed, and return() rejects with the inner-close error.
tests.push(scenarioTest({
  id: "flatmap-test-051",
  helper: "flatMap",
  label: "flatMap: return() rejects with the inner-close error when the active inner .return() throws",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the inner iterator is pulled", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    { note: "the value is delivered, leaving the inner active and idle", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    // The active inner's .return() throws; the underlying is still closed, and the
    // inner-close error is what return() rejects with.
    { note: "the inner close throws, the underlying is still closed, return() rejects", steps: [ { events: [
      { type: "arm-throw", target: "A", on: "return", error: "inner-close" },
      { type: "return", result: "ret" },
      { type: "close", target: "A", throws: true },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", error: "inner-close" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// return()'s inner close succeeds but the UNDERLYING close throws; return()
// rejects with the underlying-close error.
tests.push(scenarioTest({
  id: "flatmap-test-052",
  helper: "flatMap",
  label: "flatMap: return() rejects with the underlying-close error when the underlying .return() throws",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the inner iterator is pulled", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    { note: "the value is delivered, leaving the inner active and idle", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a0" },
      { type: "result", result: "r0", value: "a0", from: "a0" },
    ] } ] },
    { note: "the inner closes, then the underlying close throws and return() rejects", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "return", error: "underlying-close" },
      { type: "return", result: "ret" },
      { type: "close", target: "A" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source", throws: true },
      { type: "result", result: "ret", error: "underlying-close" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// CLOSE error on the success path, on the UNDERLYING this time: the inner .return()
// succeeds; the underlying .return() (invoked only after the inner close settles)
// rejects ASYNCHRONOUSLY, and return() rejects with the underlying-close error.
tests.push(scenarioTest({
  id: "flatmap-test-053",
  helper: "flatMap",
  label: "flatMap: return() while reading underlying rejects with the underlying-close error when the underlying .return() rejects",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "return() defers the closes; the call is held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "close", target: "A" },
      { type: "result", result: "r0", done: true },
    ] } ] },
    // The inner close settles cleanly; only now is the underlying closed.
    { note: "the inner closed cleanly; the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    // The underlying .return() rejects: return() rejects with the underlying-close error.
    { note: "once the underlying close rejects, return() rejects with it", steps: [ { events: [
      { type: "close-settled", target: "source", error: "underlying-close" },
      { type: "result", result: "ret", error: "underlying-close" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: deletes iterator.return (protocol-shape test)
//   reason: t.check assertion: return() returns a promise
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
tests.push(scenarioTest({
  id: "flatmap-test-055",
  helper: "flatMap",
  label: "flatMap: an inner error swallows a synchronous underlying-close throw; the stream error wins",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the inner iterator is pulled", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    // The inner pull errors (the terminal stream error). Closing the underlying
    // throws, which is swallowed; r0 still rejects with the inner error.
    { note: "the underlying-close throw is swallowed; the inner error reaches r0", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "return", error: "underlying-close" },
      { type: "settle", pull: "a0", error: "boom-inner" },
      { type: "close", target: "source", throws: true },
      { type: "result", result: "r0", error: "boom-inner" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Same, but the underlying .return() rejects ASYNCHRONOUSLY: the rejection is
// swallowed, and the inner error surfaces only once the close settles.
tests.push(scenarioTest({
  id: "flatmap-test-056",
  helper: "flatMap",
  label: "flatMap: an inner error swallows an async underlying-close rejection; the stream error wins",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "the inner iterator is pulled", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
    ] } ] },
    // The underlying close is issued (pending); the error waits for it to settle.
    { note: "the underlying close is pending; the error is withheld", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom-inner" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "the close rejection is swallowed; the inner error reaches r0", steps: [ { events: [
      { type: "close-settled", target: "source", error: "underlying-close" },
      { type: "result", result: "r0", error: "boom-inner" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// A head inner-iterator error closes the underlying via it.return(); while that
// close is still PENDING, a value already buffered behind the error (from a later
// pull of the same iterator) is delivered immediately to its call — the committed
// head error's recipient is fixed, so following values needn't wait for the close.
// Only the errored call waits for it.return() to settle. (The flatMap analogue of
// filter's "head predicate-error close delivers the value behind it immediately".)
tests.push(scenarioTest({
  id: "flatmap-test-057",
  helper: "flatMap",
  label: "flatMap: a held inner-error close delivers a value buffered behind it without waiting",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked once", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across the active iterator", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // The later pull (#1) yields first: a1 is buffered behind the still-pending head
    // pull (#0).
    { note: "the later value is buffered behind the pending head", steps: [ { events: [
      { type: "settle", pull: "a1", value: "a1" },
    ] } ] },
    // The head pull (#0) errors with the underlying close held pending. The error is
    // committed to r0 (withheld), and the buffered a1 is delivered to r1 immediately
    // — without waiting for it.return() to settle.
    { note: "the close is pending; the buffered value delivers while the error waits", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "close", target: "source" },
      { type: "result", result: "r1", value: "a1", from: "a1" },
    ] } ] },
    // Only once it.return() settles does the errored call reject.
    { note: "the errored call rejects once the close settles", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- return() while blocked on a pending mapper -----------------------------
//
// Structurally distinct from the tests above: return() lands AFTER the source has
// yielded and the mapper was invoked (so the mapper promise is pending), rather
// than while the underlying pull is in flight. The closes are deferred all the
// same: when the mapper resolves to an iterable we close it WITHOUT pulling and
// done the held call, then close the underlying once the inner close settles.
tests.push(scenarioTest({
  id: "flatmap-test-058",
  helper: "flatMap",
  label: "flatMap: return() while blocked on the mapper closes the produced iterator without pulling it",
  ticks: [
    { note: "first next() pulls the underlying", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked, now pending", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // return() lands while the mapper is still pending. Nothing closes yet; r0 is
    // held.
    { note: "return() defers the closes; the call is held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "close", target: "A" },
      { type: "result", result: "r0", done: true },
    ] } ] },
    { note: "once the inner close settles, the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "A" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the underlying close settles, return() resolves", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// return() while reading underlying with a PARKED iterator ahead. An inner iterator
// (A) reported done one short and is parked feeding p1 with an in-flight pull; the
// freed demand redirected to a fresh underlying pull that is now in flight. On
// return(): the bound demand's surplus (p3) dones eagerly, the head-most bound call
// (p2) is held, p1 keeps its parked pull, and nothing closes yet. When the in-flight
// pull yields, its iterator (B) is closed WITHOUT pulling and p2 dones — then the
// underlying closes once B's close settles; the parked value still reaches p1.
tests.push(scenarioTest({
  id: "flatmap-test-059",
  helper: "flatMap",
  label: "flatMap: return() while reading underlying with a parked iterator delivers the parked value and dones the rest",
  ticks: [
    { note: "three coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "p1" },
      { type: "next", result: "p2" },
      { type: "next", result: "p3" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 3 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
      { type: "inner-pull", pull: "a2", iterator: "A" },
    ] } ] },
    // A reports done at its MIDDLE pull (#1) with #0 still in flight: A parks keeping
    // A#0 (feeding p1); the freed demand (2, for p2/p3) reads the underlying again.
    { note: "A parks; the freed demand reads the underlying again", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // return() while reading underlying. Bound demand is 2 (p2, p3): the trailing one
    // (p3) dones eagerly; p2 (head-most bound) is held; p1 keeps its parked pull;
    // nothing closes yet.
    { note: "the surplus dones eagerly; the calls are held", steps: [ { events: [
      { type: "return", result: "pr" },
      { type: "result", result: "p3", done: true },
    ] } ] },
    // The in-flight pull yields a value; the mapper is invoked again.
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // The mapper resolves to iterator B: close it WITHOUT pulling; the held bound call
    // (p2) dones. p1 is still owed its parked value.
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "close", target: "B" },
      { type: "result", result: "p2", done: true },
    ] } ] },
    { note: "once the inner close settles, the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the underlying close settles, return() resolves", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "pr", done: true },
    ] } ] },
    // p1's parked pull finally yields: it still gets its value.
    { note: "the parked value still reaches the first call", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a1" },
      { type: "result", result: "p1", value: "a1", from: "a0" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// Same parked setup, but the in-flight pull REJECTS. The underlying faulted itself,
// so nothing is closed and return() resolves right away; the error is queued behind
// p1's still-pending parked value and reaches the held call (p2) only after p1 is
// delivered.
tests.push(scenarioTest({
  id: "flatmap-test-060",
  helper: "flatMap",
  label: "flatMap: return() while reading underlying surfaces a pull rejection behind a parked value",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "p1" },
      { type: "next", result: "p2" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks; the freed demand reads the underlying again", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Bound demand is 1 (p2): nothing to done eagerly (p2 is held); p1 keeps its parked
    // pull; nothing closes yet.
    { note: "return() defers the closes; the calls are held", steps: [ { events: [
      { type: "return", result: "pr" },
    ] } ] },
    // The in-flight pull rejects: the underlying faulted itself, so nothing is closed
    // and return() resolves immediately. The error is queued behind p1's still-pending
    // parked value.
    { note: "the pull error is queued behind the parked value; return() resolves", steps: [ { events: [
      { type: "settle", pull: "u1", error: "boom" },
      { type: "result", result: "pr", done: true },
    ] } ] },
    // p1's parked pull yields: p1 gets its value, then the error surfaces to p2.
    { note: "the parked value is delivered, then the error reaches the held call", steps: [ { events: [
      { type: "settle", pull: "a0", value: "a1" },
      { type: "result", result: "p1", value: "a1", from: "a0" },
      { type: "result", result: "p2", error: "boom" },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// The mirror of flatmap-test-060: a parked iterator's in-flight pull reports DONE
// (rather than yielding) and the in-flight underlying pull then succeeds. After
// return() while reading the underlying, the state is the same — a parked pull
// (r0's a0) ahead of one held call (r1, the position a pull/mapper rejection would
// land on). When a0 reports done its slot truncates and the freed demand can never
// be filled (we're draining and will not pull anything new), so a call settles done
// RIGHT THEN — and because results deliver in call order, the doned call is the
// LAST one (r1): at most ONE more result can be produced (an error from the
// in-flight pull/mapper, or nothing), and it must land on the head-most pending
// call, so r0 becomes the held call. r0 stays held until the in-flight pull
// resolves and its mapper settles cleanly (no error), at which point the produced
// iterator is closed without being pulled and r0 dones. (Two bugs this guards
// against: rolling the freed demand onto DrainingState.requested instead of doning
// it, which held BOTH calls open until the second mapper settled; and doning the
// head-most call while holding the last, which could deliver a rejection to r1
// after r0 had already settled done — done must be terminal in call order.)
tests.push(scenarioTest({
  id: "flatmap-test-061",
  helper: "flatMap",
  label: "flatMap: return() while reading underlying dones the trailing call as soon as a parked pull reports done",
  ticks: [
    { note: "first next() pulls the underlying", steps: [
      { events: [] },
      { events: [
        { type: "next", result: "r0" },
        { type: "pull", pull: "u0" },
      ] },
    ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: "A" },
      { type: "fn", call: "p0", arg: "A", from: "u0" },
    ] } ] },
    { note: "a second call raises the demand", steps: [ { events: [
      { type: "next", result: "r1" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    // A reports done at pull #1 with pull #0 still in flight: A is parked keeping #0
    // (bound to r0), and the freed demand (1, bound to r1) reads the underlying again.
    { note: "A parks; the freed demand reads the underlying again", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    // return() while reading the underlying: bound demand is 1 (r1, held); nothing to
    // done eagerly; r0 keeps its parked pull a0; nothing closes yet.
    { note: "return() defers the closes; the calls are held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    // A's parked pull #0 reports done. The freed demand can never be filled (we won't
    // pull anything more), so the trailing call r1 settles done immediately; r0 — the
    // head-most pending call, where a rejection would land — becomes the held call.
    { note: "the parked pull reporting done settles the trailing call r1 immediately", steps: [ { events: [
      { type: "settle", pull: "a0", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u1", value: "B" },
      { type: "fn", call: "p1", arg: "B", from: "u1" },
    ] } ] },
    // The mapper settles cleanly: the produced iterator is closed without being pulled,
    // and the held call r0 finally dones.
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "close", target: "B" },
      { type: "result", result: "r0", done: true },
    ] } ] },
    { note: "once the inner close settles, the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the underlying close settles, return() resolves", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// A PARKED iterator errors while draining. The error closes nothing (the closes are
// the draining flow's responsibility) and parks in order, rejecting its call as
// usual; draining proceeds unaffected — the held call remains the sink for a
// pull/mapper rejection, the in-flight pull's iterator is still produced and closed
// without being pulled, and the closes still run sequentially. (In particular the
// produced iterator is not leaked merely because an unrelated parked error arrived
// first.)
tests.push(scenarioTest({
  id: "flatmap-test-063",
  helper: "flatMap",
  label: "flatMap: a parked-iterator error while draining does not disturb the deferred closes",
  ticks: [
    { note: "two coalesced calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "A parks; the freed demand reads the underlying again", steps: [ { events: [
      { type: "settle", pull: "a1", done: true },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "return() defers the closes; the calls are held", steps: [ { events: [
      { type: "return", result: "ret" },
    ] } ] },
    // The parked pull rejects: the error is at the head, so it rejects r0 right away.
    // Draining is unaffected.
    { note: "the parked error rejects its call; draining proceeds", steps: [ { events: [
      { type: "settle", pull: "a0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "the in-flight underlying value is mapped", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "the produced iterator is closed without being pulled; the held call dones", steps: [ { events: [
      { type: "fn-settle", call: "p1", iterator: "B" },
      { type: "close", target: "B" },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "once the inner close settles, the underlying closes", steps: [ { events: [
      { type: "close-settled", target: "B" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "once the underlying close settles, return() resolves", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

// --- an orphaned close ------------------------------------------------------
//
// An inner done can discard a buffered inner error whose source close is still
// in flight: A's pull #1 rejects while pull #0 is still pending, so flatMap
// terminates and closes the source; pull #0 then reports done, truncating the
// never-delivered error. Both calls resolve done immediately, NOT gated on the
// still-pending source close, and the close's eventual outcome is observed by
// nothing (deliberately swallowed: the error that triggered it was discarded).
// This pins the "orphaned close" semantics; the fuzzer's close-gating invariant
// (I11) is weakened to exempt exactly this corner (see test/flatMap-fuzzer.js).
// If we ever decide the dones should instead wait for the close, flip this test
// and strengthen the fuzzer.
tests.push(scenarioTest({
  id: "flatmap-test-062",
  helper: "flatMap",
  label: "flatMap: an inner done orphans the close of a discarded inner error",
  ticks: [
    { note: "two calls, one underlying pull", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "the mapper is invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "demand 2 fans out across A", steps: [ { events: [
      { type: "fn-settle", call: "p0", iterator: "A" },
      { type: "inner-pull", pull: "a0", iterator: "A" },
      { type: "inner-pull", pull: "a1", iterator: "A" },
    ] } ] },
    { note: "the later pull's error terminates the stream and closes the source", steps: [ { events: [
      { type: "settle", pull: "a1", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "the earlier done discards the held error; the dones do not wait for the close", steps: [ { events: [
      { type: "settle", pull: "a0", done: true },
      { type: "result", result: "r0", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "the orphaned close settles; nothing observes it", steps: [ { events: [
      { type: "close-settled", target: "source" },
    ] } ] },
    { note: "the helper is finished", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "result", result: "r2", done: true },
    ] } ] },
  ],
}, { helper: flatMap, utils }));

await runTests(tests, xfailed);

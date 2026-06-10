// The map helper's unit tests. Converted (2026-06-10) from the former
// hand-written test/map.js (async-iterator-implementation), since deleted
// along with the converter: this file is the source of truth — edit it by
// hand. Run directly, or via test/scenario-tests.js in the implementation
// repo. tools/unconvert-tests.js there renders these files back into the
// old hand-written style for review.
//
// Most tests are scenario objects (see ./FORMAT.md) turned into runnable
// [name, fn] tests by scenarioTest; tests the scenario format cannot
// express were copied verbatim from the original file, each marked with a
// [copied verbatim] comment giving the reason.

import { map } from '../map.js';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';
import * as utils from './utils.js';
import { scenarioTest } from './scenario-to-test.js';

let tests = [];
let xfailed = [];

// The simple, sequential case. Pull one at a time, settle, observe. Establishes
// the basic protocol: each consumer next() pulls the source once, the mapper
// transforms the value, and `done` propagates without closing the source.
tests.push(scenarioTest({
  id: "map-test-001",
  helper: "map",
  label: "map: sequential pulls",
  ticks: [
    { note: "first next() pulls the source once", steps: [ { events: [
      { type: "fn-sync", arg: 1, value: 10 },
      { type: "fn-sync", arg: 2, value: 20 },
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "r0 maps 1 -> 10", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "result", result: "r0", value: 10 },
    ] } ] },
    { note: "second next() pulls again", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "r1 maps 2 -> 20", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "result", result: "r1", value: 20 },
    ] } ] },
    { note: "third next() pulls again", steps: [ { events: [
      { type: "next", result: "r2" },
      { type: "pull", pull: "u2" },
    ] } ] },
    // `done` propagates and the source is NOT closed on clean exhaustion — the
    // absence of any `src.return()` entry here is the assertion.
    { note: "r2 is done, source left open", steps: [ { events: [
      { type: "settle", pull: "u2", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// Concurrency in the underlying iterator. Fire two next() calls before settling
// anything, so both underlying pulls are in flight at once, then settle the
// *second* pull first. r1 is allowed to settle before r0 ("later calls may
// settle earlier"), yet each call still receives its own in-call-order value.
tests.push(scenarioTest({
  id: "map-test-002",
  helper: "map",
  label: "map: concurrent out-of-order settlement",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "fn-sync", arg: 2, value: 20 },
      { type: "fn-sync", arg: 1, value: 10 },
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "second pull settles first -> r1 resolves first", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "result", result: "r1", value: 20 },
    ] } ] },
    { note: "first pull settles -> r0 resolves with its own value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "result", result: "r0", value: 10 },
    ] } ] },
  ],
}, { helper: map, utils }));

// Concurrency through the mapper itself. With an async mapper, two in-flight
// next() calls drive the pipeline concurrently end-to-end: both underlying
// pulls and then both mapper invocations are outstanding at the same time. The
// mapper is settled out of order to show the results settle out of order while
// still carrying their in-call-order values.
tests.push(scenarioTest({
  id: "map-test-003",
  helper: "map",
  label: "map: concurrent async mapper, settled out of order",
  ticks: [
    // Both pulls are outstanding; the mapper hasn't run (nothing to map yet) —
    // shown by the absence of any fn(...) entry.
    { note: "two concurrent pulls, mapper not yet called", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Feed both source values; the mapper is now invoked for both, concurrently,
    // without waiting for the first mapping to finish (both fn entries, no result
    // yet).
    { note: "both mapper invocations in flight concurrently", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // Settle the SECOND mapping first, then the first.
    { note: "second mapping settles first -> r1 first", steps: [ { events: [
      { type: "fn-settle", call: "p1", value: "B" },
      { type: "result", result: "r1", value: "B", from: "p1" },
    ] } ] },
    { note: "first mapping settles -> r0 with its own value", steps: [ { events: [
      { type: "fn-settle", call: "p0", value: "A" },
      { type: "result", result: "r0", value: "A", from: "p0" },
    ] } ] },
  ],
}, { helper: map, utils }));

// --- Error handling -------------------------------------------------------
// An error in the predicate closes the underlying iterator (calls .return()),
// the result rejects, and the helper is now done.
tests.push(scenarioTest({
  id: "map-test-004",
  helper: "map",
  label: "map: predicate error closes the underlying iterator",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "mapper invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The predicate threw, so the underlying iterator IS closed (.return()),
    // and then the rejection propagates to the caller.
    { note: "predicate error -> close source, reject", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// An error *from* the underlying iterator (here a rejected .next()) does NOT
// close it — no .return() — but the helper still becomes done afterwards.
tests.push(scenarioTest({
  id: "map-test-005",
  helper: "map",
  label: "map: error from the underlying iterator does not close it",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // No `src.return()` entry: the underlying error is surfaced without closing.
    { note: "underlying error -> reject, source left open", steps: [ { events: [
      { type: "settle", pull: "u0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: yieldResult (raw iterator-result injection)
// A protocol violation in the result object (a throwing `value` getter) is an
// error arising from the underlying iterator, so it too must NOT close it.
tests.push(['map: throwing value getter does not close the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.yieldResult(0, { get value() { throw new Error('getter boom'); }, done: false });
  await flushMicrotasks();
  t.expectLog('bad result -> reject, source left open', ['r0 rejected getter boom']);

  const r1 = mapped.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// --- Synchronous throws ---------------------------------------------------
// A mapper that throws synchronously is treated like a rejected mapper: it
// closes the underlying iterator and the result rejects.
tests.push(scenarioTest({
  id: "map-test-007",
  helper: "map",
  label: "map: synchronous throw from the mapper closes the underlying iterator",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "fn-sync", arg: 1, error: "boom" },
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "sync mapper throw -> close source, reject", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// A synchronous throw from the underlying .next() must be surfaced as a
// rejected promise (next() must not itself throw), and must NOT close the
// underlying iterator.
tests.push(scenarioTest({
  id: "map-test-008",
  helper: "map",
  label: "map: synchronous throw from underlying .next() rejects without closing",
  ticks: [
    // (If next() were to throw synchronously here, the test itself would throw
    // and fail; the promise-not-sync-throw shape is asserted by reaching the
    // expectLog below.)
    // Surfaced as a rejection; no `src.return()`, so the source is left open.
    { note: "sync underlying throw -> reject, source left open", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "next", error: "boom" },
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0-throw0", throws: true },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// When the predicate errors, the underlying iterator is closed via .return().
// If that .return() throws synchronously, the error is swallowed (IteratorClose
// semantics) and the ORIGINAL predicate error is what reaches the caller.
tests.push(scenarioTest({
  id: "map-test-009",
  helper: "map",
  label: "map: synchronous throw from underlying .return() is swallowed",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "fn-sync", arg: 1, error: "predicate boom" },
      { type: "arm-throw", target: "source", on: "return", error: "return boom" },
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // The source's .return() throws, but the predicate error is what propagates.
    { note: "predicate error wins; return() throw swallowed", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "close", target: "source", throws: true },
      { type: "result", result: "r0", error: "predicate boom" },
    ] } ] },
  ],
}, { helper: map, utils }));

// --- return() -------------------------------------------------------------
// An explicit return() on the result closes the underlying iterator and makes
// future calls done — but a call that was already in flight is not lost: it
// still delivers its value.
tests.push(scenarioTest({
  id: "map-test-010",
  helper: "map",
  label: "map: return() closes the source; an in-flight call still delivers",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "fn-sync", arg: 1, value: 10 },
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "return() closes the underlying iterator", steps: [ { events: [
      { type: "return", result: "untracked0", untracked: true },
      { type: "close", target: "source" },
    ] } ] },
    // r0 was already pulling when return() happened; its value is not lost.
    { note: "the in-flight call still delivers its value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "result", result: "r0", value: 10 },
    ] } ] },
    { note: "a call made after return() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// return() closes the underlying iterator at most once, and is safe to call
// repeatedly.
tests.push(scenarioTest({
  id: "map-test-011",
  helper: "map",
  label: "map: return() is idempotent (closes the source at most once)",
  ticks: [
    { note: "first return() closes the source", steps: [ { events: [
      { type: "return", result: "untracked0", untracked: true },
      { type: "close", target: "source" },
    ] } ] },
    { note: "second return() does not close again", steps: [ { events: [
      { type: "return", result: "untracked1", untracked: true },
    ] } ] },
    { note: "next() after return() is done", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "result", result: "r0", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: t.check assertion: active next() returns a promise
//   reason: settles pull #0 of source before it was observed
//   reason: t.check assertion: return() returns a promise
//   reason: t.check assertion: settled next() returns a promise
// next() and return() always return promises (never a bare result object),
// and return() resolves to a proper { value: undefined, done: true } result.
tests.push(['map: next()/return() return promises; return() resolves to a done result', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  // Active next() is a promise.
  const r0 = mapped.next();
  t.check('active next() returns a promise', r0 instanceof Promise, true);
  track(t.log, 'r0', r0);
  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('r0 resolves', ['src.next() #0', 'r0 resolved {"value":10,"done":false}']);

  // return() is a promise; it closes the source (the source's .return() is
  // pending) and resolves to a done result once that close settles (not `{}`).
  const ret = mapped.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes the source', ['src.return() #0']);

  src.settleReturn(0);
  await flushMicrotasks();
  t.expectLog('return() resolves to a done result', ['ret resolved {"done":true}']);

  // A settled next() is still a promise, not a synchronous result object.
  const rDone = mapped.next();
  t.check('settled next() returns a promise', rDone instanceof Promise, true);
  track(t.log, 'rDone', rDone);
  await flushMicrotasks();
  t.expectLog('settled next() resolves done', ['rDone resolved {"done":true}']);
}]);

// --- Concurrency + errors (the two anomalies called out in the spec) ------
// "Values are not lost": when a *later* call errors first (closing the source),
// an *earlier* call that is still in flight must still deliver its result.
tests.push(scenarioTest({
  id: "map-test-013",
  helper: "map",
  label: "map: a later error does not lose an earlier in-flight result",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both mappers in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // The later call (r1) errors first, closing the source.
    { note: "later call errors, closing the source", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boom" },
    ] } ] },
    // The earlier call (r0) was still in flight; its result is not lost.
    { note: "earlier in-flight call still delivers", steps: [ { events: [
      { type: "fn-settle", call: "p0", value: "A" },
      { type: "result", result: "r0", value: "A", from: "p0" },
    ] } ] },
  ],
}, { helper: map, utils }));

// The error-case exception to ordering: an in-flight call may resolve
// done:false *after* an earlier call has errored — a sequence you would never
// observe when pulling one at a time.
tests.push(scenarioTest({
  id: "map-test-014",
  helper: "map",
  label: "map: an in-flight call may resolve done:false after an earlier error",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both mappers in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // The earlier call (r0) errors, closing the source.
    { note: "earlier call errors, closing the source", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    // r1 was already in flight, so it still resolves with a real value even
    // though it follows an errored call.
    { note: "later in-flight call still resolves done:false", steps: [ { events: [
      { type: "fn-settle", call: "p1", value: "B" },
      { type: "result", result: "r1", value: "B", from: "p1" },
    ] } ] },
  ],
}, { helper: map, utils }));

// --- The underlying iterator is closed at most once, and never after an error -
// After an explicit return() has closed the source, an in-flight call whose
// predicate then errors must NOT close the source a second time.
tests.push(scenarioTest({
  id: "map-test-015",
  helper: "map",
  label: "map: predicate error after return() does not close the source again",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "mapper invoked, still pending", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "return() closes the source", steps: [ { events: [
      { type: "return", result: "untracked0", untracked: true },
      { type: "close", target: "source" },
    ] } ] },
    // The in-flight mapper now errors: r0 rejects, but the source is NOT closed again.
    { note: "predicate error rejects r0 with no second close", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: map, utils }));

// Two concurrent in-flight calls whose predicates both error: the first closes
// the source, the second must not close it again.
tests.push(scenarioTest({
  id: "map-test-016",
  helper: "map",
  label: "map: a second concurrent predicate error does not close the source again",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both mappers in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "first predicate error closes the source", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom0" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom0" },
    ] } ] },
    { note: "second predicate error rejects with no second close", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boom1" },
      { type: "result", result: "r1", error: "boom1" },
    ] } ] },
  ],
}, { helper: map, utils }));

// The invariant: once an error from the underlying iterator has been observed,
// the source is never closed — even if a concurrent in-flight call's predicate
// later errors (which on its own would close the source).
tests.push(scenarioTest({
  id: "map-test-017",
  helper: "map",
  label: "map: predicate error does not close the source after an underlying error",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // r1's pull yields a value; its mapper is invoked and left pending.
    { note: "second pull yields, mapper in flight", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 2, from: "u1" },
    ] } ] },
    // r0's pull errors: r0 rejects and the source is left open (no close).
    { note: "underlying error rejects r0 without closing", steps: [ { events: [
      { type: "settle", pull: "u0", error: "underlying" },
      { type: "result", result: "r0", error: "underlying" },
    ] } ] },
    // r1's in-flight mapper now errors. Normally that would close the source, but
    // an underlying error has already been observed, so it must NOT.
    { note: "predicate error rejects r1 with no close", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "predicate" },
      { type: "result", result: "r1", error: "predicate" },
    ] } ] },
  ],
}, { helper: map, utils }));

// A mapper error closes the source via it.return(); while that close is still
// PENDING, the error's own call is withheld (the rejection waits for the close to
// settle) — but a later concurrent call is on an independent chain and delivers
// its value immediately, without waiting for the held close. (filter pins the
// same property with its "held error" tests; this is the map analogue.)
tests.push(scenarioTest({
  id: "map-test-018",
  helper: "map",
  label: "map: a held error close withholds its call but does not block a later one",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both mappers in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // r0's mapper errors; the source close is held pending. r0 is withheld and
    // nothing settles yet.
    { note: "the error closes the source but the close is pending; nothing settles", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    // r1 resolves on its own independent chain while the close is still pending.
    { note: "the later call delivers its value without waiting for the held close", steps: [ { events: [
      { type: "fn-settle", call: "p1", value: "B" },
      { type: "result", result: "r1", value: "B", from: "p1" },
    ] } ] },
    // Only once it.return() settles does the errored call reject.
    { note: "the errored call rejects once the close settles", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: map, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: yieldResult (raw iterator-result injection)
// --- terminal values are ignored -----------------------------------------
//
// Policy: map ignores values attached to terminal results. A `done` from the
// underlying is normalized to { value: undefined, done: true } (its value is not
// propagated), the argument passed to map's own return() is dropped, and the
// value the underlying's .return() resolves with is dropped too.
// A `done` from the underlying carrying a (non-undefined) value must not leak
// that value through: map normalizes the terminal result.
tests.push(['map: a done from the underlying does not leak its value', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  // The underlying reports done with a value attached; the mapper is not
  // invoked, and the value must be dropped (not surfaced as the result value).
  src.yieldResult(0, { value: 'leak', done: true });
  await flushMicrotasks();
  t.expectLog('done is normalized; the underlying value is dropped', [
    'r0 resolved {"done":true}',
  ]);
}]);

// The argument passed to map's own return() is ignored; the result is the
// normalized { value: undefined, done: true }.
tests.push(scenarioTest({
  id: "map-test-020",
  helper: "map",
  label: "map: return() ignores its argument",
  ticks: [
    { note: "return() closes the source and resolves a normalized done", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: map, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: helper called with a hand-rolled source
// The value the underlying's .return() resolves with is ignored; map resolves
// its own normalized done result. Hand-rolled because the controlled source's
// .return() only ever echoes the (here absent) argument.
tests.push(['map: the value from the underlying .return() is ignored', async function (t) {
  const source = {
    next() { t.log('src.next() #0'); return Promise.resolve({ value: 1, done: false }); },
    return() { t.log('src.return() #0'); return Promise.resolve({ value: 'leak', done: true }); },
    [Symbol.asyncIterator]() { return this; },
  };
  const mapped = map(source, (x) => x * 10);

  const ret = mapped.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying return value is dropped', [
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);
}]);

await runTests(tests, xfailed);

// The filter helper's unit tests. Converted (2026-06-10) from the former
// hand-written test/filter.js (async-iterator-implementation), since deleted
// along with the converter: this file is the source of truth — edit it by
// hand. Run directly, or via test/scenario-tests.js in the implementation
// repo. tools/unconvert-tests.js there renders these files back into the
// old hand-written style for review.
//
// Most tests are scenario objects (see ./FORMAT.md) turned into runnable
// [name, fn] tests by scenarioTest; tests the scenario format cannot
// express were copied verbatim from the original file, each marked with a
// [copied verbatim] comment giving the reason.

import { filter } from '../filter.js';
import {
  runTests,
  track,
  flushMicrotasks,
  controlledSource,
  controlledFn,
} from './utils.js';
import * as utils from '../../async-iterator-implementation/test/utils.js';
import { scenarioTest } from './scenario-to-test.js';

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

let tests = [];
let xfailed = [];

// The simple sequential case, including a drop. The first source value fails the
// predicate and is dropped, so the helper must pull again to find a value for the
// (single) consumer call. Establishes the basic protocol: a passing value is
// delivered, a failing one is silently dropped and triggers another pull.
tests.push(scenarioTest({
  id: "filter-test-001",
  helper: "filter",
  label: "filter: sequential, drops a value then delivers the next",
  ticks: [
    { note: "first next() pulls the source once", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "predicate invoked on the first value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // Predicate says false: value 1 is dropped, and because the consumer call is
    // still unsatisfied the helper must pull again.
    { note: "a dropped value triggers another pull", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "predicate invoked on the second value", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // This one passes, so it satisfies the consumer call.
    { note: "the passing value is delivered", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r0", value: 2, from: "p1" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// If a dropped value requires a replacement pull and that replacement .next()
// throws synchronously, the still-unsatisfied consumer call observes that source
// error. It must not be converted into done.
tests.push(scenarioTest({
  id: "filter-test-002",
  helper: "filter",
  label: "filter: synchronous source throw from replacement pull rejects the pending call",
  ticks: [
    { note: "first next() pulls the source once", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "predicate invoked on the first value", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "next", error: "source throw 1" },
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "replacement pull throws and rejects the pending call", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "pull", pull: "u1-throw0", throws: true },
      { type: "result", result: "r0", error: "source throw 1" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Clean exhaustion: a done from the underlying propagates as done and does NOT
// close the source (no src.return()), exactly as in map.
tests.push(scenarioTest({
  id: "filter-test-003",
  helper: "filter",
  label: "filter: done propagates and leaves the source open",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    // No src.return() entry: clean exhaustion does not close the source.
    { note: "done propagates, source left open", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
    ] } ] },
    { note: "a later call is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// The ordering rule that distinguishes filter from map: a later consumer call
// cannot settle with a VALUE before an earlier one, because the earlier call's
// value depends on which values were dropped. Here both predicates ultimately
// pass, but the SECOND predicate resolves first — and still r1 must wait for r0.
tests.push(scenarioTest({
  id: "filter-test-004",
  helper: "filter",
  label: "filter: a later value cannot settle before an earlier one",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both predicates in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 10, from: "u0" },
      { type: "fn", call: "p1", arg: 20, from: "u1" },
    ] } ] },
    // The later predicate resolves first. Even though pull #1's value is known to
    // pass, it cannot be handed to r1 yet: if pull #0 turns out to be dropped, this
    // value belongs to r0 instead. So nothing settles.
    { note: "later passing value cannot settle ahead of the earlier call", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
    ] } ] },
    // Now the earlier predicate resolves (also passing). r0 takes value 10, then
    // r1 takes value 20 — both in call order.
    { note: "both settle in call order", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r0", value: 10, from: "p0" },
      { type: "result", result: "r1", value: 20, from: "p1" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// The key oddity from the spec. Three concurrent calls issue three pulls. The
// THIRD pull is done while the first two return (still-pending) values, so we
// already know the sequence has at most two values — the third consumer call can
// settle done immediately. Then the first predicate resolves *false*, dropping
// that value: now at most one value remains, so the SECOND call can settle done
// too. The first call still cannot settle: it depends on the second predicate.
tests.push(scenarioTest({
  id: "filter-test-005",
  helper: "filter",
  label: "filter: done lets trailing calls settle while an earlier one is blocked",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    // Pulls #0 and #1 yield values; their predicates are invoked and left pending.
    { note: "first two predicates in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // Pull #2 is done. Values can come only from pulls #0 and #1, so there are at
    // most two values: the third consumer call can never receive one and settles
    // done now. r0 and r1 stay pending.
    { note: "done caps the sequence at two values -> r2 done", steps: [ { events: [
      { type: "settle", pull: "u2", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    // Predicate #0 resolves false: value 1 is dropped. Now at most one value (from
    // pull #1) remains, so the second consumer call settles done. r0 still waits on
    // predicate #1 — it cannot settle until we know whether value 2 passes.
    { note: "a dropped value lowers the cap to one -> r1 done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r1", done: true },
    ] } ] },
    // Predicate #1 passes: value 2 is the sole survivor and goes to the first call.
    { note: "the surviving value feeds the first call", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r0", value: 2, from: "p1" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// A done observed while an earlier pull is still pending releases *all* the
// trailing blocked calls at once (not one per event). Here pull #1 is done with
// pull #0 still pending, so at most one value is possible: both r1 and r2 settle
// done together, while r0 stays blocked on its predicate.
tests.push(scenarioTest({
  id: "filter-test-006",
  helper: "filter",
  label: "filter: a done releases all trailing blocked calls at once",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    // Pull #0 yields a value; its predicate is invoked and left pending.
    { note: "first predicate in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // Pull #1 is done. Values can come only from pull #0, so at most one value:
    // the second and third calls both settle done in this one step.
    { note: "done settles both trailing calls together", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    // The first call was never affected; its value still arrives.
    { note: "the first call still delivers its value", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r0", value: 1, from: "p0" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Regression from the bounded-exhaustive suite: if a later done wall is observed
// before an earlier done wall, truncating the later done must not decrement the
// possible-value count a second time. The first pending value still belongs to
// r0 after r1/r2 are known done.
tests.push(scenarioTest({
  id: "filter-test-007",
  helper: "filter",
  label: "filter: earlier done after later done does not erase a pending value",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "first predicate is pending", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "later done releases only the trailing call", steps: [ { events: [
      { type: "settle", pull: "u2", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    { note: "earlier done releases r1 but leaves r0 pending", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "pending value still reaches r0", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r0", value: 1, from: "p0" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Regression from the bounded-exhaustive suite: an underlying error that
// arrives before an already-observed done wall must not reopen later pulls that
// the done wall already made unobservable.
tests.push(scenarioTest({
  id: "filter-test-008",
  helper: "filter",
  label: "filter: earlier underlying error after later done does not reopen truncated pulls",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "done releases trailing calls", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    { note: "earlier underlying error rejects only r0", steps: [ { events: [
      { type: "settle", pull: "u0", error: "boom" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "truncated later pull remains ignored", steps: [ { events: [
      { type: "settle", pull: "u2", value: 99 },
    ] } ] },
  ],
}, { helper: filter, utils }));

// The done slot may arrive after earlier head slots have already been compacted
// away. The done position must still be interpreted relative to the current
// slot window, not the original pull history.
tests.push(scenarioTest({
  id: "filter-test-009",
  helper: "filter",
  label: "filter: done after head compaction still drains trailing calls",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "first predicate in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "fn", call: "p0", arg: 10, from: "u0" },
    ] } ] },
    { note: "head value settles and compacts away", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r0", value: 10, from: "p0" },
    ] } ] },
    { note: "done is relative to the compacted window", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Once a clean done has settled every outstanding consumer, later completions
// from pulls that were already issued must be harmless. They may update their
// own slot bookkeeping, but there is no consumer left to resolve or reject.
tests.push(scenarioTest({
  id: "filter-test-010",
  helper: "filter",
  label: "filter: in-flight pull completion after all calls are done is harmless",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Pull #0 is done, so no values can exist for either call. Both settle done
    // even though pull #1 is still in flight.
    { note: "earlier done settles every outstanding call", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
    // The later in-flight pull completing after that should have no observable
    // consumer effect.
    { note: "late completion is ignored", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// return() means no more demand, not "cancel the promises already handed out".
// Already-vended calls still observe their in-flight source values if those
// values pass the predicate, while calls made after return() are done.
tests.push(scenarioTest({
  id: "filter-test-011",
  helper: "filter",
  label: "filter: return() does not cancel already-requested passing values",
  ticks: [
    { note: "three pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "return() closes the source and resolves", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "predicates still run for already-requested values", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "settle", pull: "u1", value: 20 },
      { type: "settle", pull: "u2", value: 30 },
      { type: "fn", call: "p0", arg: 10, from: "u0" },
      { type: "fn", call: "p1", arg: 20, from: "u1" },
      { type: "fn", call: "p2", arg: 30, from: "u2" },
    ] } ] },
    { note: "already-requested passing values are delivered", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "fn-settle", call: "p2", verdict: true },
      { type: "result", result: "r0", value: 10, from: "p0" },
      { type: "result", result: "r1", value: 20, from: "p1" },
      { type: "result", result: "r2", value: 30, from: "p2" },
    ] } ] },
    { note: "a next() after return() is done", steps: [ { events: [
      { type: "next", result: "r3" },
      { type: "result", result: "r3", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// A source error rejects only the call that depends on that source position.
// Other already-vended calls remain tied to their own source/predicate work.
tests.push(scenarioTest({
  id: "filter-test-012",
  helper: "filter",
  label: "filter: source error does not reject unrelated outstanding calls",
  ticks: [
    { note: "three pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "only the dependent call rejects", steps: [ { events: [
      { type: "settle", pull: "u0", error: "source reject 0" },
      { type: "result", result: "r0", error: "source reject 0" },
    ] } ] },
    { note: "unrelated predicates still run", steps: [ { events: [
      { type: "settle", pull: "u1", value: 20 },
      { type: "settle", pull: "u2", value: 30 },
      { type: "fn", call: "p0", arg: 20, from: "u1" },
      { type: "fn", call: "p1", arg: 30, from: "u2" },
    ] } ] },
    { note: "unrelated outstanding calls still receive values", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r1", value: 20, from: "p0" },
      { type: "result", result: "r2", value: 30, from: "p1" },
    ] } ] },
    { note: "a later next() after the source error is done", steps: [ { events: [
      { type: "next", result: "r3" },
      { type: "result", result: "r3", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// A later source done can prove trailing calls are done even while an earlier
// source pull has not yielded anything yet. The earlier call still receives its
// value if that pending pull later produces one that passes.
tests.push(scenarioTest({
  id: "filter-test-013",
  helper: "filter",
  label: "filter: source done settles trailing calls while an earlier source pull is pending",
  ticks: [
    { note: "three pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "done from pull #1 settles trailing calls", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    { note: "the earlier source value still runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "fn", call: "p0", arg: 10, from: "u0" },
    ] } ] },
    { note: "the earlier call still delivers its value", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r0", value: 10, from: "p0" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// If an already-issued pull produces a value after a clean done has drained all
// consumers, the terminal cutoff ignores it before the predicate runs.
tests.push(scenarioTest({
  id: "filter-test-014",
  helper: "filter",
  label: "filter: late value after terminal done has no consumer effect",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "done drains all consumers", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "late value is ignored", steps: [ { events: [
      { type: "settle", pull: "u1", value: 99 },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Two concurrent calls where the first value is dropped. The drop must reissue
// a pull to replace the lost value, and the surviving values are handed to the
// calls in call order: the first survivor to r0, the second to r1 — regardless
// of which pull they came from.
tests.push(scenarioTest({
  id: "filter-test-015",
  helper: "filter",
  label: "filter: a dropped value reissues a pull; survivors go to calls in order",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both predicates in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 10, from: "u0" },
      { type: "fn", call: "p1", arg: 20, from: "u1" },
    ] } ] },
    // Pull #0 drops, so a replacement pull #2 is issued. Pull #1 passes, but as
    // the first surviving value it belongs to r0 — not r1.
    { note: "drop reissues a pull; the first survivor goes to r0", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "pull", pull: "u2" },
      { type: "result", result: "r0", value: 20, from: "p1" },
    ] } ] },
    { note: "predicate runs on the replacement value", steps: [ { events: [
      { type: "settle", pull: "u2", value: 30 },
      { type: "fn", call: "p2", arg: 30, from: "u2" },
    ] } ] },
    { note: "the second survivor goes to r1", steps: [ { events: [
      { type: "fn-settle", call: "p2", verdict: true },
      { type: "result", result: "r1", value: 30, from: "p2" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// If return() has stopped new demand, an earlier dropped value must retire the
// latest pending request, not the earlier one. A later in-flight survivor can
// still move forward to satisfy the earlier request.
tests.push(scenarioTest({
  id: "filter-test-016",
  helper: "filter",
  label: "filter: after return(), an earlier drop retires the latest pending request",
  ticks: [
    { note: "two pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "return() closes the source", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "predicate runs for the earlier value", steps: [ { events: [
      { type: "settle", pull: "u0", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u0" },
    ] } ] },
    { note: "the later pending request is retired", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "predicate runs for the later value", steps: [ { events: [
      { type: "settle", pull: "u1", value: "v1" },
      { type: "fn", call: "p1", arg: "v1", from: "u1" },
    ] } ] },
    { note: "the later survivor satisfies the earlier request", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r0", value: "v1", from: "p1" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Same return() shape, but the filtered-out value comes from the later source
// pull while the earlier pull is still pending. The later request is done; the
// earlier request still waits for its own in-flight source work.
tests.push(scenarioTest({
  id: "filter-test-017",
  helper: "filter",
  label: "filter: after return(), an out-of-order drop retires the latest pending request",
  ticks: [
    { note: "two pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "return() closes the source", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "predicate runs for the later value", steps: [ { events: [
      { type: "settle", pull: "u1", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u1" },
    ] } ] },
    { note: "the later pending request is retired", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "predicate runs for the earlier value", steps: [ { events: [
      { type: "settle", pull: "u0", value: "v1" },
      { type: "fn", call: "p1", arg: "v1", from: "u0" },
    ] } ] },
    { note: "the earlier request still receives its value", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r0", value: "v1", from: "p1" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Once a source error has closed the helper, a later in-flight value that drops
// cannot be replaced. The already-vended trailing request resolves done.
tests.push(scenarioTest({
  id: "filter-test-018",
  helper: "filter",
  label: "filter: after source error, a later drop settles the trailing request done",
  ticks: [
    { note: "two pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "source error rejects the dependent request", steps: [ { events: [
      { type: "settle", pull: "u0", error: "source reject 0" },
      { type: "result", result: "r0", error: "source reject 0" },
    ] } ] },
    { note: "predicate runs for the later value", steps: [ { events: [
      { type: "settle", pull: "u1", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u1" },
    ] } ] },
    { note: "the trailing request settles done without a replacement pull", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// A filtered-out out-of-order value still consumes one in-flight source slot.
// If the source is still open, the helper must immediately pull a replacement.
// But an error from that replacement cannot be assigned to a result request
// until earlier filtering decisions are known: an earlier drop could shift the
// replacement error forward to the earlier request.
tests.push(scenarioTest({
  id: "filter-test-019",
  helper: "filter",
  label: "filter: out-of-order replacement error waits behind earlier filtering",
  ticks: [
    { note: "two pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "predicate runs for the later value", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "next", error: "source throw 2" },
      { type: "settle", pull: "u1", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u1" },
    ] } ] },
    { note: "replacement pull errors but waits behind the earlier request", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "pull", pull: "u2-throw0", throws: true },
    ] } ] },
    { note: "predicate runs for the earlier value", steps: [ { events: [
      { type: "settle", pull: "u0", value: "v1" },
      { type: "fn", call: "p1", arg: "v1", from: "u0" },
    ] } ] },
    { note: "the earlier request settles before the replacement error is observed", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r0", value: "v1", from: "p1" },
      { type: "result", result: "r1", error: "source throw 2" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// A drop lowers the possible value count, but before a terminal event the
// helper must not use that finite-looking count to settle trailing calls done:
// another replacement pull can still produce more values.
tests.push(scenarioTest({
  id: "filter-test-020",
  helper: "filter",
  label: "filter: non-terminal drops do not drain trailing calls",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "first predicate in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    { note: "drop reissues a pull but does not settle anyone done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "pull", pull: "u3" },
    ] } ] },
    { note: "remaining predicates run", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "settle", pull: "u2", value: 3 },
      { type: "settle", pull: "u3", value: 4 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
      { type: "fn", call: "p2", arg: 3, from: "u2" },
      { type: "fn", call: "p3", arg: 4, from: "u3" },
    ] } ] },
    { note: "all waiting calls still receive values", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "fn-settle", call: "p2", verdict: true },
      { type: "fn-settle", call: "p3", verdict: true },
      { type: "result", result: "r0", value: 2, from: "p1" },
      { type: "result", result: "r1", value: 3, from: "p2" },
      { type: "result", result: "r2", value: 4, from: "p3" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Values are not lost: a later predicate error closes the source and ends the
// helper, but an earlier in-flight value still reaches its call. The error then
// reaches the call that was scanning into it.
tests.push(scenarioTest({
  id: "filter-test-021",
  helper: "filter",
  label: "filter: a later error does not lose an earlier in-flight value",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both predicates in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 10, from: "u0" },
      { type: "fn", call: "p1", arg: 20, from: "u1" },
    ] } ] },
    // The later predicate errors first, closing the source. r0 is still pending on
    // pull #0, so nothing is delivered to it yet.
    { note: "later predicate error closes the source", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    // Pull #0 passes: its value is not lost and still reaches r0; only then does
    // the error reach r1.
    { note: "earlier value delivered, then the error reaches r1", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r0", value: 10, from: "p0" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boom" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Error handling mirrors map: an error from the predicate closes the underlying
// iterator (.return()), the result rejects, and the helper is done thereafter.
tests.push(scenarioTest({
  id: "filter-test-022",
  helper: "filter",
  label: "filter: predicate error closes the underlying iterator",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "predicate invoked", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
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
}, { helper: filter, utils }));

tests.push(scenarioTest({
  id: "filter-test-023",
  helper: "filter",
  label: "filter: synchronous predicate throw closes the underlying iterator",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "fn-sync", arg: 1, error: "predicate throw 0" },
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "sync predicate throw -> close source, reject", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "predicate throw 0" },
    ] } ] },
    { note: "subsequent next() is done", steps: [ { events: [
      { type: "next", result: "r1" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: helper called with a hand-rolled source
//   reason: threw during recording: Cannot read properties of undefined (reading 'resolve')
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
tests.push(scenarioTest({
  id: "filter-test-025",
  helper: "filter",
  label: "filter: a predicate-error close does not block later calls behind the held error",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    // Pull #2 yields; its predicate passes -> a kept value buffered behind the
    // still-pending earlier positions.
    { note: "the third value runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u2", value: 30 },
      { type: "fn", call: "p0", arg: 30, from: "u2" },
    ] } ] },
    { note: "the kept value is buffered behind the pending head", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
    ] } ] },
    // Pull #1 yields; its predicate errors, closing the source via a pending
    // it.return(). The error sits behind the still-pending pull #0, so nothing
    // settles yet — in particular r2 is not done, because pull #0 could still be a
    // value that would feed it.
    { note: "the second value runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p1", arg: 20, from: "u1" },
    ] } ] },
    { note: "the predicate error closes the source; nothing settles yet", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    // Pull #0 yields and is dropped, exposing the error at the head. Its recipient
    // (r0) is now fixed and it cannot be dropped, so pull #2's value flows to r1 and
    // the now-surplus r2 settles done — without waiting for the pending it.return().
    { note: "the first value runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "fn", call: "p2", arg: 10, from: "u0" },
    ] } ] },
    { note: "the value behind the error is delivered and the surplus call is done", steps: [ { events: [
      { type: "fn-settle", call: "p2", verdict: false },
      { type: "result", result: "r1", value: 30, from: "p0" },
      { type: "result", result: "r2", done: true },
    ] } ] },
    // Only when it.return() settles does the error finally surface to r0.
    { note: "the held error surfaces once the close settles", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// The same effect when the erroring value is already at the head of the queue
// when its predicate errors. A value buffered behind it (pull #1's, kept) is
// delivered to r1 the moment the head predicate errors and closes the source,
// without waiting for the pending it.return(); only r0 — the error's recipient —
// waits for the close.
tests.push(scenarioTest({
  id: "filter-test-026",
  helper: "filter",
  label: "filter: a head predicate-error close delivers the value behind it immediately",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Pull #1 yields; its predicate passes -> a kept value buffered behind the
    // still-pending head (pull #0).
    { note: "the second value runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 20, from: "u1" },
    ] } ] },
    { note: "the kept value is buffered behind the pending head", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
    ] } ] },
    // Pull #0 yields; its predicate errors at the head of the queue, closing the
    // source via a pending it.return(). The error's recipient (r0) is fixed, so the
    // value behind it is delivered to r1 immediately — not blocked on the close.
    { note: "the head value runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "fn", call: "p1", arg: 10, from: "u0" },
    ] } ] },
    { note: "the close is called and the value behind the error is delivered", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boom" },
      { type: "close", target: "source" },
      { type: "result", result: "r1", value: 20, from: "p0" },
    ] } ] },
    // Only when it.return() settles does the error surface to r0.
    { note: "the held error surfaces once the close settles", steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: helper called with a hand-rolled source
//   reason: threw during recording: Cannot read properties of undefined (reading 'resolve')
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
tests.push(scenarioTest({
  id: "filter-test-028",
  helper: "filter",
  label: "filter: a source done after a source error still caps the over-pulled error",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Source error at the later pull; it sits behind the still-pending pull #0. A
    // source error does not close the source.
    { note: "the source error waits behind the pending head", steps: [ { events: [
      { type: "settle", pull: "u1", error: "boom" },
    ] } ] },
    // The earlier pull then resolves done. The source was never closed, so this done is
    // a real wall: it ends the sequence at #0 and caps the over-pulled error at #1.
    { note: "the done caps the over-pulled error -> both calls done", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// return(): the buried outcome here is a *value*. After return() closes the source,
// pull #1 yields a value that passes; the still-pending earlier pull #0 then resolves
// done. That late done is still a wall: it discards pull #1's already-determined value
// along with its own slot, so both calls drain to done and the value never surfaces.
tests.push(scenarioTest({
  id: "filter-test-029",
  helper: "filter",
  label: "filter: a late source done after return() walls away an already-requested value",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "return() closes the source", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    // Pull #1 yields a passing value, buffered behind the still-pending pull #0.
    { note: "the second value runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 20, from: "u1" },
    ] } ] },
    { note: "the value is buffered behind the pending head", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
    ] } ] },
    // The earlier pull resolves done. This late done walls away pull #1's value.
    { note: "the late done walls away the buffered value; both calls drain to done", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: helper called with a hand-rolled source
//   reason: unparseable expected log line: pred(A)
//   reason: threw during recording: Cannot read properties of undefined (reading 'resolve')
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
tests.push(scenarioTest({
  id: "filter-test-031",
  helper: "filter",
  label: "filter: a predicate error does not force an already-vended call to done",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    // Only pull #1 yields (pull #0 stays pending); its predicate is invoked.
    { note: "predicate invoked on the second value", steps: [ { events: [
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 20, from: "u1" },
    ] } ] },
    // The predicate errors. The source is closed, but nothing settles yet: r0/r1
    // are still in order behind pull #0, and r2 is NOT forced to done — it is
    // still owed whatever pull #2 produces.
    { note: "error closes the source; no call is forced to done", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    // Pull #0 yields a passing value: it reaches r0 (not lost). Only then does the
    // error reach r1 — the call at the erroring value's position.
    { note: "predicate invoked on the first value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "fn", call: "p1", arg: 10, from: "u0" },
    ] } ] },
    { note: "earlier value delivered, then the error reaches r1", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r0", value: 10, from: "p1" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r1", error: "boom" },
    ] } ] },
    // r2's own in-flight pull resolves with a passing value: it gets that value,
    // done:false — the error never turned it into a done.
    { note: "predicate invoked on the third value", steps: [ { events: [
      { type: "settle", pull: "u2", value: 30 },
      { type: "fn", call: "p2", arg: 30, from: "u2" },
    ] } ] },
    { note: "the already-vended third call still delivers a value", steps: [ { events: [
      { type: "fn-settle", call: "p2", verdict: true },
      { type: "result", result: "r2", value: 30, from: "p2" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Mirrors the map invariant "an in-flight call may resolve done:false after an
// earlier error": the first predicate errors (rejecting r0 and closing the
// source), yet r1 — already in flight — still resolves with its own value.
tests.push(scenarioTest({
  id: "filter-test-032",
  helper: "filter",
  label: "filter: an in-flight call still resolves with a value after an earlier error",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both predicates in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // The earlier predicate errors: r0 rejects and the source closes. r1 is left
    // pending on its own predicate, not forced to done.
    { note: "earlier error rejects r0 and closes the source", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "later in-flight call still resolves done:false", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r1", value: 2, from: "p1" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// We must not leave a vended promise unsettled. After an error the source is
// closed and no replacement pulls happen, so a vended call whose value would
// have required a *new* pull (its in-flight slot drops) settles done rather than
// hanging.
tests.push(scenarioTest({
  id: "filter-test-033",
  helper: "filter",
  label: "filter: after an error, a vended call that would need a new pull settles done",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "predicate invoked on the first value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The first predicate errors: r0 (at that position) rejects and the source
    // closes. r1 is left in flight on pull #1.
    { note: "error rejects r0 and closes the source", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
    { note: "predicate invoked on the second value", steps: [ { events: [
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    // Pull #1 drops. Normally that reissues a pull to satisfy r1, but the source
    // is closed — so r1 can never be served and settles done instead of hanging.
    { note: "the un-serviceable vended call settles done", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: false },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Same return()-then-drop shape as above, but after a head value has already
// compacted out of the slot window. This exercises the value ceiling without
// absolute consumer positions.
tests.push(scenarioTest({
  id: "filter-test-034",
  helper: "filter",
  label: "filter: return after head compaction still drains an unserviceable call",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both predicates in flight", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "head value settles before return", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r0", value: 1, from: "p0" },
    ] } ] },
    { note: "return closes after compaction", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "remaining call settles done without a replacement pull", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: false },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// return() closes the source the same way, so it too must not strand a vended
// call whose value would need a new pull.
tests.push(scenarioTest({
  id: "filter-test-035",
  helper: "filter",
  label: "filter: after return(), a vended call that would need a new pull settles done",
  ticks: [
    { note: "a pull is in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "return() closes the source", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "close", target: "source" },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "predicate still runs on the in-flight value", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The in-flight value is dropped; with the source closed there is no
    // replacement pull, so r0 settles done instead of hanging.
    { note: "the un-serviceable vended call settles done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r0", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

tests.push(scenarioTest({
  id: "filter-test-036",
  helper: "filter",
  label: "filter: return() after source done does not close the source",
  ticks: [
    { note: "two pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "source done settles outstanding calls", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { note: "return() after source done does not call source.return()", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

tests.push(scenarioTest({
  id: "filter-test-037",
  helper: "filter",
  label: "filter: return() after source error does not close the source",
  ticks: [
    { note: "two pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "source error rejects its dependent call", steps: [ { events: [
      { type: "settle", pull: "u0", error: "source reject 0" },
      { type: "result", result: "r0", error: "source reject 0" },
    ] } ] },
    { note: "return() after source error does not call source.return()", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "result", result: "ret", done: true },
    ] } ] },
    { note: "already-requested value still runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 20, from: "u1" },
    ] } ] },
    { note: "already-requested value still reaches its call", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: true },
      { type: "result", result: "r1", value: 20, from: "p0" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Regression from the bounded-exhaustive suite: if an underlying error is
// sitting behind an earlier predicate that later drops, the error shifts forward
// to the earlier call, and any already-vended trailing call that would need a
// new pull must settle done rather than hang.
tests.push(scenarioTest({
  id: "filter-test-038",
  helper: "filter",
  label: "filter: underlying error behind an earlier drop drains trailing calls",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "first predicate is pending", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
    ] } ] },
    // The underlying error is in the second retained slot, so it cannot surface
    // until the first slot is resolved.
    { note: "underlying error waits behind the earlier predicate", steps: [ { events: [
      { type: "settle", pull: "u1", error: "boom" },
    ] } ] },
    // Dropping the first slot makes the underlying error reject r0. With the
    // source terminal and no replacement pull possible, r1 resolves done.
    { note: "error shifts forward and the trailing call drains", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r0", error: "boom" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Same shape, but the terminal event is a predicate error rather than an
// underlying error. The erroring value still occupies a slot, so when an earlier
// value drops the error moves forward and trailing unserviceable calls drain.
tests.push(scenarioTest({
  id: "filter-test-039",
  helper: "filter",
  label: "filter: predicate error behind an earlier drop drains trailing calls",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "both predicates are pending", steps: [ { events: [
      { type: "settle", pull: "u0", value: 1 },
      { type: "settle", pull: "u1", value: 2 },
      { type: "fn", call: "p0", arg: 1, from: "u0" },
      { type: "fn", call: "p1", arg: 2, from: "u1" },
    ] } ] },
    { note: "later predicate error closes but waits behind the first predicate", steps: [ { events: [
      { type: "fn-settle", call: "p1", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "error shifts forward and the trailing call drains", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r1", done: true },
    ] } ] },
    { steps: [ { events: [
      { type: "close-settled", target: "source" },
      { type: "result", result: "r0", error: "boom" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// --- Source done / error caps interacting with filtered-out values ---
// A done is terminal for every later source position, even one that was
// eagerly pulled and already errored before the done arrived. The speculative
// error at slot #2 must be discarded — not resurrected to satisfy the earlier
// pending call when its own value is dropped.
tests.push(scenarioTest({
  id: "filter-test-040",
  helper: "filter",
  label: "filter: a source done retroactively caps a later already-observed error",
  ticks: [
    { note: "first two pulls are in flight", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Arm the third pull to throw synchronously, then vend the third call so that
    // pull #2 (and only pull #2) throws.
    { note: "third pull throws synchronously and is stored, settling nothing", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "next", error: "source throw 2" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u2-throw0", throws: true },
    ] } ] },
    // Done at slot #1 (slot #0 still pending). The done caps slot #2, so the
    // stored error is suppressed: r1 (its own position) and r2 (past the done)
    // both settle done.
    { note: "done caps the later error -> r1 and r2 done", steps: [ { events: [
      { type: "settle", pull: "u1", done: true },
      { type: "result", result: "r1", done: true },
      { type: "result", result: "r2", done: true },
    ] } ] },
    // The still-pending earlier value arrives and is dropped. With the source
    // already done there is no replacement pull and no error to expose, so r0 is
    // simply done.
    { note: "predicate runs for the earlier value", steps: [ { events: [
      { type: "settle", pull: "u0", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u0" },
    ] } ] },
    { note: "dropped value followed by the capped done -> r0 done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r0", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Once a source error has already rejected its own call (r0), a later
// out-of-order value that drops retires the *latest* pending call (r2) done,
// while the middle call (r1) stays pending behind its own in-flight slot.
tests.push(scenarioTest({
  id: "filter-test-041",
  helper: "filter",
  label: "filter: a consumed source error no longer blocks a later done",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "the error rejects its dependent call", steps: [ { events: [
      { type: "settle", pull: "u0", error: "source reject 0" },
      { type: "result", result: "r0", error: "source reject 0" },
    ] } ] },
    // Slot #2 yields out of order while slot #1 is still pending.
    { note: "predicate runs for the out-of-order value", steps: [ { events: [
      { type: "settle", pull: "u2", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u2" },
    ] } ] },
    // The drop cannot be replaced (source is terminal), and slot #2 is past the
    // error cap, so the latest call retires done. r1 is still owed slot #1.
    { note: "the latest pending call retires done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r2", done: true },
    ] } ] },
    { note: "the middle call stays pending", steps: [ { events: [
    ] } ] },
  ],
}, { helper: filter, utils }));

// A known error sits one slot behind the head. Dropping the head exposes the
// error as the next retained outcome, so it must reject the earliest pending
// call before any later done is emitted.
tests.push(scenarioTest({
  id: "filter-test-042",
  helper: "filter",
  label: "filter: a filtered-out value before a known error compacts the error first",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    // Error at slot #1 cannot surface while slot #0 is unresolved.
    { note: "error waits behind the unresolved head", steps: [ { events: [
      { type: "settle", pull: "u1", error: "source reject 1" },
    ] } ] },
    { note: "predicate runs for the head value", steps: [ { events: [
      { type: "settle", pull: "u0", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u0" },
    ] } ] },
    // Dropping the head exposes the slot #1 error as the next outcome: it rejects
    // r0. Slot #2 is still in flight and is owed to r1, so only r2 (beyond it,
    // with no new pulls coming) retires done; r1 stays pending.
    { note: "error compacts forward to r0; the latest call retires done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r0", error: "source reject 1" },
      { type: "result", result: "r2", done: true },
    ] } ] },
    { note: "the middle call stays pending behind its in-flight slot", steps: [ { events: [
    ] } ] },
  ],
}, { helper: filter, utils }));

// An error cap sits at slot #1 while slot #0 is still pending. A later
// out-of-order value (slot #2) drops; because slot #2 is past the cap and
// cannot be replaced, the latest call retires done while the earlier two wait.
tests.push(scenarioTest({
  id: "filter-test-043",
  helper: "filter",
  label: "filter: a later filtered-out value after a pending error retires the latest done",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "error at slot #1 waits behind the pending head", steps: [ { events: [
      { type: "settle", pull: "u1", error: "source reject 1" },
    ] } ] },
    // Slot #2 yields while slot #0 is still pending.
    { note: "predicate runs for the out-of-order value", steps: [ { events: [
      { type: "settle", pull: "u2", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u2" },
    ] } ] },
    { note: "the latest call is beyond the cap and retires done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r2", done: true },
    ] } ] },
    { note: "the earlier two calls stay pending", steps: [ { events: [
    ] } ] },
  ],
}, { helper: filter, utils }));

// The latest in-flight slot (#2) is a known error cap. An earlier value
// (slot #0) drops while slot #1 is still pending. The latest call can be done
// regardless of how slot #1 compacts, because at most two outcomes remain for
// three calls.
tests.push(scenarioTest({
  id: "filter-test-044",
  helper: "filter",
  label: "filter: an earlier filtered-out value before a later pending error retires the latest done",
  ticks: [
    { note: "three concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "next", result: "r2" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
      { type: "pull", pull: "u2" },
    ] } ] },
    { note: "error at the latest slot waits behind the earlier slots", steps: [ { events: [
      { type: "settle", pull: "u2", error: "source reject 2" },
    ] } ] },
    // Slot #0 yields while slot #1 is still pending.
    { note: "predicate runs for the head value", steps: [ { events: [
      { type: "settle", pull: "u0", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u0" },
    ] } ] },
    { note: "only the latest call retires done", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "result", result: "r2", done: true },
    ] } ] },
    { note: "the earlier two calls stay pending", steps: [ { events: [
    ] } ] },
  ],
}, { helper: filter, utils }));

// A replacement pull (triggered by a drop) throws, but the error's final
// filtered position is unknown while an earlier slot is unresolved. When that
// earlier value also drops, the error compacts forward to the earliest call and
// the tail call drains done — the rejection observed before the done.
tests.push(scenarioTest({
  id: "filter-test-045",
  helper: "filter",
  label: "filter: a compacted source error rejects before the tail done",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Arm the replacement pull to throw, then drop slot #1's value so the helper
    // issues that replacement pull (#2), which throws.
    { note: "predicate runs for the later value", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "next", error: "source throw 2" },
      { type: "settle", pull: "u1", value: "v0" },
      { type: "fn", call: "p0", arg: "v0", from: "u1" },
    ] } ] },
    { note: "replacement pull throws but waits: slot #0 is unresolved", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "pull", pull: "u2-throw0", throws: true },
    ] } ] },
    { note: "predicate runs for the earlier value", steps: [ { events: [
      { type: "settle", pull: "u0", value: "v1" },
      { type: "fn", call: "p1", arg: "v1", from: "u0" },
    ] } ] },
    // The earlier value also drops, so the compacted error is now the sole
    // surviving outcome: it rejects r0, and r1 drains done after it.
    { note: "compacted error rejects r0 before the tail done", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: false },
      { type: "result", result: "r0", error: "source throw 2" },
      { type: "result", result: "r1", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// Directly targets the worry that #issuePull's *synchronous* error branch does
// not call #processQueue itself: if a buried synchronous source error needs no
// subsequent next() to surface, then the only thing that drives the queue
// forward is the earlier blocking position settling on its own. Here pull #1's
// value is dropped, issuing replacement pull #2 which throws synchronously while
// pull #0 is still pending — so the error sits buried, and NO further next() is
// ever called. When pull #0 finally yields a passing value, r0 takes it and the
// buried error must then reach r1. If the synchronous branch truly stranded the
// error, r1 would stay pending forever and the final assertion would fail.
tests.push(scenarioTest({
  id: "filter-test-046",
  helper: "filter",
  label: "filter: a buried synchronous source error surfaces with no subsequent next()",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    // Arm the replacement pull to throw synchronously.
    // Pull #1 yields out of order while pull #0 is still pending; its predicate runs.
    { note: "the later value runs the predicate", steps: [ { events: [
      { type: "arm-throw", target: "source", on: "next", error: "replacement throw" },
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 20, from: "u1" },
    ] } ] },
    // Dropping it issues replacement pull #2, which throws synchronously. The error
    // is buried behind the still-pending pull #0, so nothing settles — and from here
    // on no further next() is ever called.
    { note: "replacement throws but the error is buried behind the pending head", steps: [ { events: [
      { type: "fn-settle", call: "p0", verdict: false },
      { type: "pull", pull: "u2-throw0", throws: true },
    ] } ] },
    // The earlier pull finally yields a passing value: r0 takes it, then the buried
    // error must reach r1 — driven only by this settlement, not by any new next().
    { note: "the earlier value runs the predicate", steps: [ { events: [
      { type: "settle", pull: "u0", value: 10 },
      { type: "fn", call: "p1", arg: 10, from: "u0" },
    ] } ] },
    { note: "earlier value delivered, then the buried error reaches r1", steps: [ { events: [
      { type: "fn-settle", call: "p1", verdict: true },
      { type: "result", result: "r0", value: 10, from: "p1" },
      { type: "result", result: "r1", error: "replacement throw" },
    ] } ] },
  ],
}, { helper: filter, utils }));

// --- terminal values are ignored -----------------------------------------
//
// Policy (matching map/flatMap): filter ignores values attached to terminal
// results. The argument passed to filter's own return() is dropped — both on a
// live helper and on an already-finished one — and the value the underlying's
// .return() resolves with is dropped too.
// The argument to return() on a live helper is ignored.
tests.push(scenarioTest({
  id: "filter-test-047",
  helper: "filter",
  label: "filter: return() ignores its argument",
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
}, { helper: filter, utils }));

// The argument to return() on an already-finished helper is ignored too.
tests.push(scenarioTest({
  id: "filter-test-048",
  helper: "filter",
  label: "filter: return() after finishing ignores its argument",
  ticks: [
    { note: "first next() pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "pull", pull: "u0" },
    ] } ] },
    { note: "source done settles the call", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
      { type: "result", result: "r0", done: true },
    ] } ] },
    { note: "return() on a finished helper resolves a normalized done", steps: [ { events: [
      { type: "return", result: "ret" },
      { type: "result", result: "ret", done: true },
    ] } ] },
  ],
}, { helper: filter, utils }));

// [copied verbatim: not representable as a scenario]
//   reason: helper called with a hand-rolled source
// The value the underlying's .return() resolves with is ignored. Hand-rolled
// because the controlled source's .return() only ever echoes its argument.
tests.push(['filter: the value from the underlying .return() is ignored', async function (t) {
  const source = {
    next() { t.log('src.next() #0'); return Promise.resolve({ value: 1, done: false }); },
    return() { t.log('src.return() #0'); return Promise.resolve({ value: 'leak', done: true }); },
    [Symbol.asyncIterator]() { return this; },
  };
  const pred = controlledFn(t.log, 'pred');
  const f = filter(source, pred.fn);

  const ret = f.return();
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('the underlying return value is dropped', [
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);
}]);

// --- an orphaned close ------------------------------------------------------
//
// A terminal done can discard a buffered predicate error whose source close is
// still in flight: pull #1's value fails the predicate (which closes the
// source), but pull #0 then reports done -- the terminal wall discards the
// never-delivered error, and BOTH calls resolve done immediately, NOT gated on
// the still-pending close. The close's eventual outcome is then observed by
// nothing (deliberately swallowed: the error that triggered it was discarded).
// This pins the "orphaned close" semantics; the fuzzer's close-gating invariant
// is weakened to exempt exactly this corner (see test/filter-fuzzer.js). If we
// ever decide the dones should instead wait for the close, flip this test and
// strengthen the fuzzer.
tests.push(scenarioTest({
  id: "filter-test-049",
  helper: "filter",
  label: "filter: a terminal done orphans the close of a discarded predicate error",
  ticks: [
    { note: "two concurrent pulls", steps: [ { events: [
      { type: "next", result: "r0" },
      { type: "next", result: "r1" },
      { type: "pull", pull: "u0" },
      { type: "pull", pull: "u1" },
    ] } ] },
    { note: "the later pull's predicate is invoked", steps: [ { events: [
      { type: "settle", pull: "u1", value: 20 },
      { type: "fn", call: "p0", arg: 20, from: "u1" },
    ] } ] },
    { note: "the predicate error closes the source; the error is held behind pull #0", steps: [ { events: [
      { type: "fn-settle", call: "p0", error: "boom" },
      { type: "close", target: "source" },
    ] } ] },
    { note: "the earlier done discards the held error; the dones do not wait for the close", steps: [ { events: [
      { type: "settle", pull: "u0", done: true },
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
}, { helper: filter, utils }));

await runTests(tests, xfailed);

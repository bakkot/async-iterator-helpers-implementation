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

// --- Error handling -------------------------------------------------------

// An error in the predicate closes the underlying iterator (calls .return()),
// the result rejects, and the helper is now done.
tests.push(['map: predicate error closes the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const fn = controlledFn(t.log, 'fn');
  const mapped = map(src.iterator, fn.fn);

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('mapper invoked', ['fn(1) #0']);

  fn.reject(0, new Error('boom'));
  await flushMicrotasks();
  // The predicate threw, so the underlying iterator IS closed (.return()),
  // and then the rejection propagates to the caller.
  t.expectLog('predicate error -> close source, reject', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  const r1 = mapped.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// An error *from* the underlying iterator (here a rejected .next()) does NOT
// close it — no .return() — but the helper still becomes done afterwards.
tests.push(['map: error from the underlying iterator does not close it', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.throw(0, new Error('boom'));
  await flushMicrotasks();
  // No `src.return()` entry: the underlying error is surfaced without closing.
  t.expectLog('underlying error -> reject, source left open', ['r0 rejected boom']);

  const r1 = mapped.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

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
tests.push(['map: synchronous throw from the mapper closes the underlying iterator', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, () => { throw new Error('boom'); });

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('sync mapper throw -> close source, reject', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  const r1 = mapped.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// A synchronous throw from the underlying .next() must be surfaced as a
// rejected promise (next() must not itself throw), and must NOT close the
// underlying iterator.
tests.push(['map: synchronous throw from underlying .next() rejects without closing', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  src.throwNext(new Error('boom'));

  let r0;
  let threwSync = false;
  try {
    r0 = mapped.next();
  } catch {
    threwSync = true;
  }
  t.check('next() returns a promise rather than throwing synchronously', threwSync, false);
  if (threwSync) return;

  track(t.log, 'r0', r0);
  await flushMicrotasks();
  // Surfaced as a rejection; no `src.return()`, so the source is left open.
  t.expectLog('sync underlying throw -> reject, source left open', [
    'src.next() #0 (throws)',
    'r0 rejected boom',
  ]);

  const r1 = mapped.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('subsequent next() is done', ['r1 resolved {"done":true}']);
}]);

// When the predicate errors, the underlying iterator is closed via .return().
// If that .return() throws synchronously, the error is swallowed (IteratorClose
// semantics) and the ORIGINAL predicate error is what reaches the caller.
tests.push(['map: synchronous throw from underlying .return() is swallowed', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, () => { throw new Error('predicate boom'); });

  src.throwReturn(new Error('return boom'));

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('first next() pulls', ['src.next() #0']);

  src.yield(0, 1);
  await flushMicrotasks();
  // The source's .return() throws, but the predicate error is what propagates.
  t.expectLog('predicate error wins; return() throw swallowed', [
    'src.return() #0 (throws)',
    'r0 rejected predicate boom',
  ]);
}]);

// --- return() -------------------------------------------------------------

// An explicit return() on the result closes the underlying iterator and makes
// future calls done — but a call that was already in flight is not lost: it
// still delivers its value.
tests.push(['map: return() closes the source; an in-flight call still delivers', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('a pull is in flight', ['src.next() #0']);

  mapped.return();
  await flushMicrotasks();
  t.expectLog('return() closes the underlying iterator', ['src.return() #0']);

  // r0 was already pulling when return() happened; its value is not lost.
  src.yield(0, 1);
  await flushMicrotasks();
  t.expectLog('the in-flight call still delivers its value', [
    'r0 resolved {"value":10,"done":false}',
  ]);

  const r1 = mapped.next();
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('a call made after return() is done', ['r1 resolved {"done":true}']);
}]);

// return() closes the underlying iterator at most once, and is safe to call
// repeatedly.
tests.push(['map: return() is idempotent (closes the source at most once)', async function (t) {
  const src = controlledSource(t.log, 'src');
  const mapped = map(src.iterator, (x) => x * 10);

  mapped.return();
  await flushMicrotasks();
  t.expectLog('first return() closes the source', ['src.return() #0']);

  mapped.return();
  await flushMicrotasks();
  t.expectLog('second return() does not close again', []);

  const r0 = mapped.next();
  track(t.log, 'r0', r0);
  await flushMicrotasks();
  t.expectLog('next() after return() is done', ['r0 resolved {"done":true}']);
}]);

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

  // return() is a promise that resolves to a done result (not `{}`).
  const ret = mapped.return();
  t.check('return() returns a promise', ret instanceof Promise, true);
  track(t.log, 'ret', ret);
  await flushMicrotasks();
  t.expectLog('return() closes source and resolves to a done result', [
    'src.return() #0',
    'ret resolved {"done":true}',
  ]);

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
tests.push(['map: a later error does not lose an earlier in-flight result', async function (t) {
  const src = controlledSource(t.log, 'src');
  const fn = controlledFn(t.log, 'fn');
  const mapped = map(src.iterator, fn.fn);

  const r0 = mapped.next();
  const r1 = mapped.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.yield(0, 1);
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('both mappers in flight', ['fn(1) #0', 'fn(2) #1']);

  // The later call (r1) errors first, closing the source.
  fn.reject(1, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('later call errors, closing the source', [
    'src.return() #0',
    'r1 rejected boom',
  ]);

  // The earlier call (r0) was still in flight; its result is not lost.
  fn.resolve(0, 'A');
  await flushMicrotasks();
  t.expectLog('earlier in-flight call still delivers', [
    'r0 resolved {"value":"A","done":false}',
  ]);
}]);

// The error-case exception to ordering: an in-flight call may resolve
// done:false *after* an earlier call has errored — a sequence you would never
// observe when pulling one at a time.
tests.push(['map: an in-flight call may resolve done:false after an earlier error', async function (t) {
  const src = controlledSource(t.log, 'src');
  const fn = controlledFn(t.log, 'fn');
  const mapped = map(src.iterator, fn.fn);

  const r0 = mapped.next();
  const r1 = mapped.next();
  track(t.log, 'r0', r0);
  track(t.log, 'r1', r1);
  await flushMicrotasks();
  t.expectLog('two concurrent pulls', ['src.next() #0', 'src.next() #1']);

  src.yield(0, 1);
  src.yield(1, 2);
  await flushMicrotasks();
  t.expectLog('both mappers in flight', ['fn(1) #0', 'fn(2) #1']);

  // The earlier call (r0) errors, closing the source.
  fn.reject(0, new Error('boom'));
  await flushMicrotasks();
  t.expectLog('earlier call errors, closing the source', [
    'src.return() #0',
    'r0 rejected boom',
  ]);

  // r1 was already in flight, so it still resolves with a real value even
  // though it follows an errored call.
  fn.resolve(1, 'B');
  await flushMicrotasks();
  t.expectLog('later in-flight call still resolves done:false', [
    'r1 resolved {"value":"B","done":false}',
  ]);
}]);

runTests(tests);

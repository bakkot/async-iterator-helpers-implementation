// Test helpers for driving concurrent async-iterator combinators by hand.
//
// Nothing here is time-based. The only thing that ever causes a promise to
// settle is an explicit call by the test (via a `Promise.withResolvers()`
// handle). `flushMicrotasks` merely lets *already-decided* promise reactions
// run; it cannot, on its own, make anything resolve.

// Drain the microtask queue so every promise reaction that is *already* able
// to run does run. Each `await` schedules one microtask; once the queue is
// empty the remaining iterations are harmless no-ops. This is how we advance
// to a quiescent state between manual settlements without using timers.
export async function flushMicrotasks(rounds = 100) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// An ordered, shared event log. Concurrency/ordering claims are checked
// against the order entries land in `entries`. Silent by design: nothing is
// printed, so a passing run produces no output and the log is a pure trace
// that can itself be asserted on.
export function makeLog() {
  const entries = [];
  function log(...parts) {
    const line = parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ');
    entries.push(line);
    return line;
  }
  return { log, entries };
}

// Run a list of [name, fn] tests, passing each a context `t` carrying the
// assertions. Quiet on success: nothing is printed for a passing test. The
// first failure within a test prints the test name; every failure prints its
// own detail. Exits 1 if anything failed, otherwise prints "all tests passed"
// and exits 0.
export async function runTests(tests) {
  let totalFailures = 0;
  for (const [name, fn] of tests) {
    const t = makeTestContext(name);
    await fn(t);
    totalFailures += t.failures;
  }
  if (totalFailures > 0) {
    process.exitCode = 1;
  } else {
    console.log('all tests passed');
  }
}

function makeTestContext(name) {
  let printedName = false;
  const ctx = {
    failures: 0,
    // Compare two values via JSON; report only on mismatch.
    check(label, actual, expected) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) ctx._fail(label, [`expected ${e}, got ${a}`]);
    },
    // Element-wise array comparison (deep-compared via JSON); on mismatch,
    // print both arrays so the difference is easy to spot.
    compareArray(label, actual, expected) {
      let ok = Array.isArray(actual) && actual.length === expected.length;
      for (let i = 0; ok && i < expected.length; i++) {
        if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) ok = false;
      }
      if (!ok) {
        ctx._fail(label, [
          `expected: ${JSON.stringify(expected)}`,
          `actual:   ${JSON.stringify(actual)}`,
        ]);
      }
    },
    _fail(label, detailLines) {
      if (!printedName) {
        console.log(`FAIL: ${name}`);
        printedName = true;
      }
      console.log(`  ${label}`);
      for (const line of detailLines) console.log(`    ${line}`);
      ctx.failures++;
    },
  };
  return ctx;
}

// Attach settlement logging to a consumer promise *without* awaiting it, so
// several `.next()` calls can be in flight at once and we can see the order
// in which they settle.
export function track(log, label, promise) {
  promise.then(
    (v) => log(`${label} resolved`, v),
    (e) => log(`${label} rejected`, errMsg(e)),
  );
  return promise;
}

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

// A manually-driven async iterator.
//
// Every `.next()` returns a pending promise the test settles later, so we can
// observe how many concurrent pulls the combinator issued and settle them in
// whatever order we like. `.return()` settlement is also test-controlled and
// recorded, which is how we check whether the underlying iterator was closed.
//
// Methods to drive it:
//   yield(i, value)  -> settle pull #i with { value, done: false }
//   finish(i)        -> settle pull #i with { value: undefined, done: true }
//   throw(i, err)    -> reject pull #i (an error *from* the underlying iterator)
//   yieldResult(i, r)-> settle pull #i with an arbitrary result object (e.g. one
//                       with a throwing `value` getter, to test protocol violations)
export function controlledSource(log, name = 'src') {
  const pulls = [];
  const returnDeferreds = [];
  let returnCount = 0;

  const iterator = {
    next() {
      const i = pulls.length;
      const d = Promise.withResolvers();
      pulls.push(d);
      log(`${name}.next() #${i}`);
      return d.promise;
    },
    return(value) {
      const i = returnCount++;
      const d = Promise.withResolvers();
      returnDeferreds.push(d);
      log(`${name}.return() #${i}`);
      // Default to resolving immediately; tests that need to control return
      // timing can use `settleReturn`.
      d.resolve({ value, done: true });
      return d.promise;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return {
    iterator,
    get returned() {
      return returnCount > 0;
    },
    get returnCount() {
      return returnCount;
    },
    pullCount() {
      return pulls.length;
    },
    yield: (i, value) => pulls[i].resolve({ value, done: false }),
    finish: (i) => pulls[i].resolve({ value: undefined, done: true }),
    throw: (i, err) => pulls[i].reject(err),
    yieldResult: (i, result) => pulls[i].resolve(result),
  };
}

// A manually-driven (async) mapper/predicate. Each invocation is logged and
// returns a pending promise the test settles, so we can drive mapper
// concurrency and mapper errors independently of the source.
//
//   resolve(i, mapped) -> settle call #i with `mapped`
//   reject(i, err)     -> settle call #i by throwing (an error *in* the predicate)
export function controlledFn(log, name = 'fn') {
  const calls = [];

  function fn(value) {
    const i = calls.length;
    const d = Promise.withResolvers();
    calls.push({ value, deferred: d });
    log(`${name}(${JSON.stringify(value)}) #${i}`);
    return d.promise;
  }

  return {
    fn,
    callCount: () => calls.length,
    argOf: (i) => calls[i].value,
    resolve: (i, mapped) => calls[i].deferred.resolve(mapped),
    reject: (i, err) => calls[i].deferred.reject(err),
  };
}

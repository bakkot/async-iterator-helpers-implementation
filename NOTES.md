# Notes

Concurrent `map` / `filter` / `flatMap` for async iterators, with their tests.

`map(it, fn)` takes an async iterator and a (possibly async) mapper and returns a
new async iterator. It is **concurrent**: calling `.next()` several times before
earlier calls settle issues several `.next()` calls to the underlying iterator at
once, and those may settle in any order. Only `map` exists so far (`map.js`);
`filter` and `flatMap` are the eventual goal.

## Invariants

These are the properties the implementation must hold (and that the tests
check). "The machinery" = the `map` helper; "the underlying" = the source
iterator `it`; "the predicate" = the mapper `fn`.

1. **Who closes the underlying.** An error from the **predicate** closes the
   underlying iterator (calls `it.return()`). Errors *from* the underlying —
   a rejected `.next()`, a synchronously-throwing `.next()`, or a protocol
   violation such as a throwing `value` getter on the result object — do **not**
   close it.
2. **Done is terminal.** After any error (predicate or underlying) or an explicit
   `.return()` on the result, the helper is done: every *later* `.next()`
   immediately settles `{ done: true }`. The underlying is closed **at most
   once**.
3. **Never close after an underlying error.** Once the machinery has observed an
   error (or protocol violation) from the underlying, it must never call
   `it.return()` — even if a concurrent in-flight call's predicate later errors
   (which on its own would close it).
4. **Result-sequence ordering.** Reading the results of concurrent calls *in call
   order* yields the same sequence you'd get by awaiting each call before making
   the next (assuming the underlying iterator itself behaves that way). The one
   exception is errors: after an error you may observe a `{ done: false }` that a
   sequential consumer never would (because the call was already in flight).
5. **Values are not lost.** An error in one call does not prevent the caller from
   obtaining the result of an *earlier* call that was in flight but had not yet
   settled. (Errors do prevent *new* calls from producing values — see #2.)
6. **Protocol shape.** `.next()` and `.return()` always return promises (even
   once done — never a bare result object). `.return()` resolves to
   `{ value: undefined, done: true }`.

### The `#done` flag

The implementation leans on a single `#done` boolean. It is set by *every*
terminal event: underlying done, underlying error, predicate error, explicit
`.return()`. The key consequence: **the underlying is still "open" iff `#done` is
false**, so the machinery only ever calls `it.return()` when `#done` was false at
that moment. That one rule gives invariants 1–3 together.

### Known open question

`map.js` has a `TODO` on the underlying-done branch: when the underlying returns
`{ value, done: true }`, should the helper forward that `value` or force
`undefined`? It is currently forwarded. The exhaustive test sidesteps this by
only ever scripting done-results with `value: undefined`, so it does not pin the
answer down. Decide this when convenient and add a test.

## Test architecture

Two suites, no dependencies, all promise resolution **manually driven** (never
time-based). Run with plain `node`.

### Shared helpers — `test/utils.js`

- `Promise.withResolvers()` is used directly wherever a manually-settled promise
  is needed (no custom `Deferred`).
- `flushMicrotasks()` — spins the microtask queue so that *already-decided*
  promise reactions run. It cannot, by itself, settle anything; only an explicit
  test action does that. This is how we advance to a quiescent state between
  manual settlements without timers.
- `controlledSource(log, name)` — a hand-driven async iterator. Each `.next()`
  returns a pending promise the test settles later; `.next()`/`.return()` are
  logged. Drive it with `yield(i, v)`, `finish(i)`, `throw(i, err)`,
  `yieldResult(i, obj)` (arbitrary result object, e.g. a throwing `value`
  getter), and `throwNext(err)` / `throwReturn(err)` (synchronous throws). Whether
  the underlying was closed is visible in the log (`src.return()`), not via a
  flag.
- `controlledFn(log, name)` — a hand-driven (async) mapper. `fn` is logged per
  call; settle invocation `i` with `resolve(i, mapped)` or `reject(i, err)`.
- `track(log, label, promise)` — logs when a consumer promise settles and with
  what, *without* awaiting it, so several calls can be in flight at once and we
  see the order they settle in.
- `runTests(tests)` — runs `[name, async fn]` pairs, each given a context `t`.
  `t.log` (the event log), `t.expectLog(label, expected)` and `t.check(label,
  actual, expected)` are the assertions. **Quiet on success** (prints only
  `all tests passed`, exit 0); on failure prints the test name once plus each
  failure's detail and exits 1.

The central manual-testing idiom: **assert against the event log incrementally.**
`t.expectLog(label, expected)` checks the events logged *since the last call* and
then clears them, so each assertion concerns only the newly-logged events and the
exact match means "nothing else happened" too (e.g. the absence of a
`src.return()` entry is how we assert the underlying wasn't closed).

### Example suite — `test/map.js`

Hand-written scenarios for `map`: basic protocol, concurrency (out-of-order
settlement of both the underlying and the mapper), the error/`return` rules,
synchronous throws (mapper, underlying `.next()`, underlying `.return()`), and the
close-at-most-once / no-close-after-underlying-error cases. Tests self-register
via `tests.push([...])`. Run: `node test/map.js`.

### Bounded-exhaustive differential test — `test/map-bounded-exhaustive.js`

Any case we think should be tested gets a test in `test/map.js`. But we can't
think of everything. For that, we have enumeration.

Enumerates **every distinct schedule** of up to `N` consumer calls and checks the
real `map` against a reference oracle. Run: `node test/map-bounded-exhaustive.js
[N]` (default 2; 3 is quick; 4 is exhaustive and takes a couple of minutes).

Core concepts:

- An **event** is one atomic step; a **schedule** is a total order of events.
  Event kinds: a consumer `.next()`/`.return()` (bundled with the *shape* of the
  underlying response it triggers), and the settlement of a previously-pending
  underlying pull, mapper call, or underlying `.return()`.
- **Response-shape alphabet:** underlying `.next()` ∈ {syncValue, syncDone,
  syncThrow, pending}; mapper ∈ {syncValue, syncThrow, pending}; underlying
  `.return()` ∈ {sync, pending}. Pending pulls settle to value/done/reject;
  pending mappers to value/reject. **Protocol violations are deliberately
  excluded** from the alphabet (the manual suite covers them).
- **Values are pure functions of obligation id** (`P0`, `m(P0)`, `Epull0`, …) so
  the oracle and the real run agree on values without coordinating a counter.
- Between events we **flush to quiescence**, making the timeline discrete and
  each schedule deterministic.

The pieces:

- `runModel` is the **oracle**: a synchronous model that encodes the *desired
  concurrent semantics* (the invariants above) and emits, for one schedule, a
  per-step trace and each call's settled result. It is the source of truth — a
  mismatch against it is a finding about the implementation.
- `enumerate(N)` is a DFS over the space of schedules, driving `runModel` via a
  `Chooser`/decision-vector; it `yield`s each complete schedule.
- `runReal(schedule)` drives the **real** `map` through the same schedule (with a
  controlled source/mapper that respond per the schedule's shapes) and records
  its trace.
- Comparison is **per-step and order-insensitive within a step** (a sorted
  multiset of observable events) — intra-flush microtask ordering is an
  implementation detail; what's asserted is *which step* each event lands in.

Three checks per schedule:

1. **Trace equality** — real run vs oracle.
2. **The no-close-after-underlying-error invariant** (#3) — checked directly and
   independently of the oracle, by flagging any `it.return()` once an underlying
   error has been observed.
3. **Sequential-property cross-check** (#4) — only for schedules where the
   underlying is *well-behaved* (error-free, and all values precede any done in
   pull order). Computes the expected call-order result sequence independently of
   the oracle and compares it to the oracle's results, which validates the oracle
   itself on the cases where the ordering property is justified.

## Extending to `filter` / `flatMap`

The harness is reusable: `controlledSource`/`controlledFn`/`runTests` and the
exhaustive skeleton (`Chooser`, `enumerate`, the per-step trace comparison) carry
over. What changes is the **concurrent semantics**, so each combinator needs its
own oracle (`runModel`) and its own scripted-response handling — `filter` drops
values (a pull can map to "no result, pull again"), and `flatMap` pulls from
inner iterators, both of which change the obligation structure. Keep the
invariants above as the spec the new oracle must encode.

## Status

`map` passes the manual suite and the exhaustive test at N = 1–4.

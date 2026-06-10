# Scenario format

A **scenario** is a plain, JSON-serializable JS object describing one execution
of an async-iterator helper (`map`, `filter`, or `flatMap`) at the level of
observable events. The same scenario can be:

- **run as a unit test** against the real implementation
  (`scenario-to-test.js` drives the controlled source/fn helpers from
  `test/utils.js` and asserts the event log tick by tick), and
- **rendered as an animation** (`scenario-to-animation.js` compiles it to the
  `{ id, label, content, steps }` object the `index.html` player consumes).

There are three closely-related dialects — one per helper — sharing a common
core. They differ only in what the per-element function (`fn`) settles with:
a mapped **value** (`map`), a boolean **verdict** (`filter`), or an **inner
iterator** (`flatMap`, which additionally has inner-pull events).

## Top level

```js
{
  id: 'filter-concurrent',        // unique across all helpers (used as URL hash)
  helper: 'filter',               // 'map' | 'filter' | 'flatMap' — selects the dialect
  label: 'Simple concurrent',     // animation tab text; also used in the test name
  description: '...html...',      // animation-only blurb (optional)
  names: { source: 'src', fn: 'pred', fnDisplay: 'pred' },  // optional, see Names
  display: { records: true },     // animation-only: render values as full
                                  // { done, value } iterator records (optional)
  ticks: [ /* Tick objects, see below */ ],
}
```

### Names

`names.source` and `names.fn` are the log names used by the controlled
helpers (they appear in expected log lines); `names.fnDisplay` is the name
shown in animation Internal-box labels. Defaults per helper:

| helper  | source | fn     | fnDisplay |
|---------|--------|--------|-----------|
| map     | `src`  | `fn`   | `f`       |
| filter  | `src`  | `pred` | `pred`    |
| flatMap | `src`  | `m`    | `f`       |

## Ticks, steps, events

The hierarchy is **scenario → ticks → steps → events**.

- A **tick** is one quiescent microtask interval: a batch of external
  settlements followed by everything the helper observably does in response.
  In test terms: perform the tick's *stimuli* in order, `await
  flushMicrotasks()`, then assert that the log since the previous tick equals
  the tick's *observations*, in order.
- A **step** is one animation step (one click of the stepper). A tick contains
  one or more steps; the split is purely presentational — this is how the
  format represents animations that spread a single microtask cascade over
  several beats.
- An **event** is the atom. Events are ordered within a step, and the
  flattened order across steps/ticks is the scenario's claimed observable
  order. When an animation step holds several events, they animate
  simultaneously (exactly as today), but their array order still records the
  real sequence — this is how same-tick orderings that the animation doesn't
  visually sequence (e.g. two results resolving "together") are captured.

```js
// Tick
{
  note: 'two concurrent pulls',   // optional; used as the expectLog label
  steps: [
    {
      caption: '...html...',      // animation caption (optional for test-only scenarios)
      arrows: [ ['U0','I0'] ],    // optional OVERRIDE; normally arrows are derived
      events: [ /* Event objects */ ],
    },
  ],
}
```

Steps with `events: []` are legal (idle/summary beats).

**Ordering rule:** within a tick, every stimulus must precede every
observation. If an animation interleaves them (a settlement beat after a
reaction beat), cut a new tick at that point — inserting extra microtask
flushes is unobservable to these implementations, so finer ticks are always
safe.

## Events

Every event is `{ type, ...fields }`. Events fall into four categories:

- **stimulus** — something the outside world does (the test performs it; the
  animation usually shows a box going pending or settling).
- **observation** — something the helper observably does (the test asserts it
  via the log; the animation shows the corresponding visual).
- **annotation** — animation-only; no execution meaning (tombstones, the
  closing band sliding open, voiding, compaction). Ignored by the test
  executor.
- **definition** — declares behavior of a *synchronous* (uncontrolled) fn;
  collected before execution rather than executed in place.

### Handles

Events refer to promises and iterators by scenario-unique string **handles**,
introduced at first mention. Conventions (not enforced, but use them):
results `r0, r1, …` and `ret` for `.return()`; underlying pulls `u0, u1, …`;
fn calls `p0, p1, …`; inner iterators `A, B, …`; inner pulls `a0…, b0…`.
Log indices (`#0`, `#1`, …) are *derived from occurrence order*, never from
the handle's spelling.

### Stimuli

| event | meaning / test action |
|---|---|
| `{ type: 'next', result: 'r0' }` | consumer calls `.next()`; the promise is tracked under the handle. `untracked: true` means the original test never observed the promise — the executor still makes the call but does not track it, so its settlement produces no log line |
| `{ type: 'return', result: 'ret' }` | consumer calls `.return()` (same `untracked` option) |
| `{ type: 'settle', pull: 'u0', value: X }` | the iterator owning that pull yields `{ value: X, done: false }` (works for underlying *and* inner pulls) |
| `{ type: 'settle', pull: 'u0', done: true }` | … resolves `{ done: true }` |
| `{ type: 'settle', pull: 'u0', error: 'msg' }` | … rejects with `Error('msg')` |
| `{ type: 'fn-settle', call: 'p0', value: X }` | **map**: mapper call resolves with `X` |
| `{ type: 'fn-settle', call: 'p0', verdict: true }` | **filter**: predicate call resolves `true`/`false` |
| `{ type: 'fn-settle', call: 'p0', iterator: 'A' }` | **flatMap**: mapper call resolves with a fresh controlled inner iterator named `A` |
| `{ type: 'fn-settle', call: 'p0', error: 'msg' }` | any helper: the fn call rejects |
| `{ type: 'arm-throw', target: 'source', on: 'next', error: 'msg' }` | the *next* `.next()`/`.return()` (per `on`) on that iterator throws synchronously (`target` is `'source'` or an inner-iterator handle) |
| `{ type: 'close-settled', target: 'source' }` | settle the next outstanding (non-throwing) `.return()` on that iterator with `{ done: true }`; with `error: 'msg'` reject it instead. Like `pull` ↔ `settle`, every `close` returns a pending promise and stays pending until its `close-settled` (the ordering rule forces this into a tick after the `close`). The animation settles the matching `c0`/`c2` box |

### Observations

| event | log line |
|---|---|
| `{ type: 'pull', pull: 'u1' }` | `src.next() #1` |
| `{ type: 'pull', pull: 'u1', throws: true }` | `src.next() #1 (throws)` — the armed sync throw fired; no promise exists, and (matching `controlledSource`) the index is **not** consumed |
| `{ type: 'inner-pull', pull: 'a0', iterator: 'A' }` | `A.next() #0` (flatMap only) |
| `{ type: 'fn', call: 'p0', arg: X, from: 'u1' }` | `pred(<json X>) #0` — `from` names the pull whose value fed this call (drives the animation arrow; optional but expected) |
| `{ type: 'close', target: 'source' }` | `src.return() #0` (`target` may be an inner handle: `A.return() #0`) |
| `{ type: 'close', target: 'source', throws: true }` | `src.return() #0 (throws)` |
| `{ type: 'result', result: 'r0', value: X, from: 'p0' }` | `r0 resolved {"value":<json>,"done":false}` — `from` (a fn-call handle or an inner-pull handle) drives the delivery arrow; omit it for deliveries with no arrow |
| `{ type: 'result', result: 'r1', done: true }` | `r1 resolved {"done":true}` (also used for `ret`) |
| `{ type: 'result', result: 'r0', error: 'msg' }` | `r0 rejected msg` |

### Annotations (animation-only)

| event | visual |
|---|---|
| `{ type: 'open-closing' }` | the teardown band slides in (`#main +shifted`, `#closing +shown`) |
| `{ type: 'tombstone', target: 'underlying' }` | reveal `#tomb-underlying` / `#tomb-result` (🪦 = "closed") |
| `{ type: 'compact', pull: 'u1' }` | the Internal slot fed by that pull drops out (`+gone`); later slots climb (`+upN` recomputed) and a spare (`i4`/`i5`) is spawned. Used after a filter drop, or to discard the empty slot of an exhausted pull |
| `{ type: 'void', pull: 'u3' }` (or `call:`/`result:`) | the purple states: an unsettled box gets `-pending +voided`, an already-settled one just `+voided` |
| `{ type: 'slot-error', pull: 'u1' }` | a source error propagates into the Internal slot: `+settled +errored` plus the `.err` text |

### Definitions

| event | meaning |
|---|---|
| `{ type: 'fn-sync', arg: X, value/verdict/error: … }` | the fn is a plain synchronous function; on argument `X` (matched by JSON equality) it returns/throws as given. A scenario using any `fn-sync` must not use `fn-settle`. The synthesized sync fn does not log (matching the plain inline fns the hand-written tests use), so such scenarios normally contain no `fn` observations. Position is irrelevant (definitions are collected before execution); by convention they sit at the front of the first step. Not animatable yet. |

## Derivation rules (animation)

- **Result rows**: `next` handles map to `r0…r3` in event order; `return`'s
  promise lives in the closing band as `c1`.
- **Underlying rows**: `pull` handles map to `u0…u3` in event order.
- **Internal slots**: a fn call occupies the Internal *element* with the same
  index as the pull that fed it (`from: 'u2'` → `#i2`); compaction adjusts its
  *visual* row via `+upN`, which the compiler tracks (this matches every
  existing animation). Arrows use visual rows.
- **Inner iterators** (flatMap): an `fn-settle … iterator: 'A'` replaces its
  mapper box with `#fi<slot>`; that iterator's pulls map to `#m<slot>0…3` in
  per-iterator order.
- **Arrows**: derived from `from` fields (`fn` → `U→I`, `result` → `I→R` or
  `#m…→R`). A step-level `arrows` array overrides derivation for that step.
- **Content**: box texts accumulate from events (`settle` → Underlying `.val`,
  `fn` → label `fnDisplay(arg)`, `fn-settle` → `.sub`, `result` → Result
  `.val`, errors → `'Error'`, `close`/`close-settled` → `'{}'`). With
  `display.records`, live values render as `{ done: 'false', value: X }`
  records and `done` as `{ done: 'true' }`.

A scenario that exceeds the diagram (more than 4 result rows / underlying
pulls / inner pulls per iterator) is **valid as a test but not animatable**;
the compiler throws. The reverse limitation also exists: tests that need
hand-rolled sources (throwing `value` getters, `.return()` that settles other
pulls, sync-cascading sources) are outside this format and stay hand-written —
as verbatim `tests.push(...)` entries inside the `*-test-scenarios.js` files.

## Execution as a test

```js
import { scenarioTest } from '../../async-iterator-animations/scenarios/scenario-to-test.js';
import * as utils from './utils.js';
import { filter } from '../filter.js';

tests.push(scenarioTest(myScenario, { helper: filter, utils }));
```

The executor builds `controlledSource`/`controlledFn` (plus one controlled
source per flatMap inner iterator), runs each tick's stimuli in order, flushes
microtasks, and `expectLog`s the tick's observations (label = `note`).

## Where things live

This directory (`async-iterator-animations/scenarios/`) holds the format and
both executors so the browser page can import them relative to its served
root; the implementation repo's tests import across the sibling checkout. The
scenario *data* files live here too, and are the **source of truth** — the
hand-written animation files and unit-test files they were converted from
have been deleted, along with the one-shot converters. Edit the scenario
files directly.

- `{map,filter,flatmap}-scenarios.js` — the animations; `index.html` compiles
  them at load via `scenario-to-animation.js`, and the implementation repo's
  `test/scenario-animation-check.js` runs them as tests.
- `{map,filter,flatmap}-test-scenarios.js` — the unit-test suites. Not pure
  data: they mirror the shape of the former hand-written test files — one
  `tests.push(...)` per test, `await runTests(tests, xfailed)` at the
  bottom — so each is a standalone runnable test file (importing the helper
  and test utils across the sibling checkout; run them directly or via the
  implementation repo's `test/scenario-tests.js`). Representable tests are
  scenario objects wrapped in `scenarioTest(...)`; tests outside the format
  were copied in verbatim from the originals, marked `[copied verbatim]`
  with the reason.

For review, the implementation repo's `tools/unconvert-tests.js` renders the
test-scenario files back into the old hand-written style
(`test/roundtrip-*.js`, runnable, lossy in names/whitespace only).

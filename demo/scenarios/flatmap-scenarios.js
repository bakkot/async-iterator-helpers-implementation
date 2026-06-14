// The flatmap animations, as scenarios (see ./FORMAT.md); index.html compiles
// them to step timelines at load. Converted (2026-06-09) from the former
// hand-written flatmap-animations.js, since deleted along with the converter:
// this file is the source of truth — edit it by hand (same-tick event-order
// fixes in particular are expected).

// (header comment carried over from the original flatmap-animations.js:)
/* ----------------------------------------------------------------
   flatMap animations. Same machinery as map/filter (see
   FORMAT.md), with one new wrinkle in the Internal
   column: the mapper `f(x)` doesn't return a value, it returns an
   (async) *iterator*. So when an Internal box settles, it is
   *replaced* by that inner iterator — drawn as a short horizontal
   run of four smaller (~2/3-size) promise boxes (#fi{row} wrappers
   holding #m{row}{col}). flatMap walks each inner iterator to
   exhaustion, forwarding every value to Result, before pulling the
   next source value. Arrows from an inner box use the element-id
   form ('#m00') so they leave the small box itself.
   ---------------------------------------------------------------- */

export const flatMapScenarios = [
  {
    id: "flatmap-non-concurrent",
    helper: "flatMap",
    label: "Simple non-concurrent",
    description: "This is a baseline for <code>flatMap</code> with no concurrency. It works like you'd expect.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b0", value: "b1" },
            { type: "result", result: "r2", value: "b1", from: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r3" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "b1", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b1", done: true },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", done: true },
            { type: "result", result: "r3", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-concurrent",
    helper: "flatMap",
    label: "Concurrent",
    description: "Unlike <code>map</code> and <code>filter</code>, issuing two pulls does not immediately trigger two pulls of the underlying iterator. Instead they are held until an inner iterator is available.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "Once the inner iterator is available, the machinery pulls enough times to fulfill all requests which cannot be fulfilled by earlier inner-iterator pulls.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", done: true },
            { type: "result", result: "r2", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-concurrent-2",
    helper: "flatMap",
    label: "Concurrent 2",
    description: "As with <a href=\"#filter-concurrent\"><code>filter</code></a>, later results cannot be delivered until earlier results have settled so we know where the later ones go.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b0", value: "b1" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "When the 2nd Promise from the 1st inner iterator resolves, we now know that it is a value and not <code>done: true</code>, so we know where to deliver both it and the value waiting from the next inner iterator.",
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
            { type: "result", result: "r2", value: "b1", from: "b0" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-concurrent-2-prime",
    helper: "flatMap",
    label: "Concurrent 2′",
    description: "Same as <a href=\"#filter-concurrent-2\">the previous example</a>, except the 1st inner iterator ultimately yields one value. You can see that the value from the 2nd inner iterator goes to a different place, which is why we could not resolve it earlier. Also note that this also reveals we have one fewer values than we might have had, so we need to pull from the active (latest) inner iterator again.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b0", value: "b1" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "inner-pull", pull: "b1", iterator: "B" },
            { type: "result", result: "r1", value: "b1", from: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b1", value: "b2" },
            { type: "result", result: "r2", value: "b2", from: "b1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-delayed-delivery",
    helper: "flatMap",
    label: "Delayed delivery*",
    description: "In the current implementation we do not deliver later values from the head-of-queue inner iterator, although we could, and doing so would be more like <code>map</code>.<br><br><strong>Open question</strong>: Should we? It's a bunch of extra bookkeeping for probably not much benefit, but it is currently inconsistent.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", value: "a1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a0" },
            { type: "result", result: "r0", value: "a0", from: "a0" },
            { type: "result", result: "r1", value: "a1", from: "a1" },
          ],
        },
      ] },
    ],
  },
  {
    id: "flatmap-exhaustion",
    helper: "flatMap",
    label: "Exhaustion",
    description: "Exhaustion works like you'd expect. As with the other helpers, previous requests can still deliver.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", done: true },
            { type: "result", result: "r2", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-exhaustion-2",
    helper: "flatMap",
    label: "Exhaustion 2*",
    description: "Getting <code>done: true</code> from an inner iterator voids any following Promises from that iterator.<br><br><strong>Open question</strong>: <code>unhandledrejection</code>?",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
          ],
        },
        {
          events: [
            { type: "void", pull: "a2" },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a2", value: "a3" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
            { type: "inner-pull", pull: "b0", iterator: "B" },
            { type: "inner-pull", pull: "b1", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b0", value: "b1" },
            { type: "result", result: "r1", value: "b1", from: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b1", value: "b2" },
            { type: "result", result: "r2", value: "b2", from: "b1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-closing",
    helper: "flatMap",
    label: "Closing",
    description: "If we call <code>result.return()</code> while an inner iterator is active, we close both it and the underlying iterator (sequentially), then resolve the Promise from <code>result.return()</code>. Outstanding values from the inner iterator may still settle.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "return", result: "ret" },
          ],
        },
        {
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
            { type: "close", target: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "A" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-closing-2",
    helper: "flatMap",
    label: "Closing 2",
    description: "We close only the underlying iterator and the active inner iterator, because earlier inner iterators are definitionally closed. They may still have outstanding Promises, however, which can still be delivered.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "return", result: "ret" },
            { type: "close", target: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "B" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b0", value: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a0" },
            { type: "result", result: "r0", value: "a0", from: "a0" },
            { type: "result", result: "r1", value: "b0", from: "b0" },
          ],
        },
      ] },
    ],
  },
  {
    id: "flatmap-closing-during-pull",
    helper: "flatMap",
    label: "Closing during pull",
    description: "When <code>result.return()</code> is called while we are blocked on pulling from the underlying iterator or on the mapper, we wait for that to settle and close the resulting iterator (to obey the invariant that code that receives an iterator is responsible for closing it), and finally close the underlying iterator once that close settles. Only once both closes complete does the <code>result.return()</code> Promise settle.<br><br>We hold open a Promise from <code>result.next()</code> in case the underlying pull or the mapper throws.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "return", result: "ret" },
          ],
        },
        {
          events: [
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          caption: "Because we now know that the inner iterator did not error, we can resolve the outstanding <code>result.next()</code> Promise. We also immediately close the inner iterator.",
          events: [
            { type: "close", target: "B" },
            { type: "result", result: "r1", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Only once <code>inner.return()</code> has settled do we call <code>underlying.return()</code>.",
          events: [
            { type: "close-settled", target: "B" },
            { type: "tombstone", target: "underlying" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "ret", done: true },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-closing-during-pull-2",
    helper: "flatMap",
    label: "Closing during pull 2",
    description: "Same scenario as <a href=\"#flatmap-closing-during-pull\">Closing during pull</a>, except we have an extra pull. This one can resolve as soon as <code>result.return()</code> is invoked: we only need to delay resolving a single Promise to hold possible errors. As in that case, <code>underlying.return()</code> is not called until the <code>inner.return()</code> triggered by the mapper settling has itself settled, matching the <a href=\"#flatmap-closing\">simple case</a>.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a0" },
            { type: "result", result: "r0", value: "a0", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "return", result: "ret" },
            { type: "result", result: "r2", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
            { type: "close", target: "B" },
            { type: "result", result: "r1", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "B" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-underlying",
    helper: "flatMap",
    label: "Error in underlying",
    description: "As always, errors from the underlying stream are considered to close it, and do not trigger <code>underlying.return()</code>.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", error: "boom" },
          ],
        },
        {
          events: [
            { type: "result", result: "r1", done: true },
            { type: "result", result: "r0", error: "boom" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r2" },
            { type: "result", result: "r2", done: true },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-mapper",
    helper: "flatMap",
    label: "Error in mapper",
    description: "Errors in the mapper function do close the underlying iterator.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", error: "boom" },
          ],
        },
        {
          events: [
            { type: "close", target: "source" },
            { type: "result", result: "r1", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "r0", error: "boom" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-underlying-during-return",
    helper: "flatMap",
    label: "Error in underlying during return",
    description: "Same scenario as <a href=\"#flatmap-closing-during-pull\">Closing during pull</a>, except now the underlying pull throws. This demonstrates why we kept a Promise from <code>result.next()</code> unresolved: so that it can surface this Error.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a0" },
            { type: "result", result: "r0", value: "a0", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "return", result: "ret" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", error: "boom" },
            { type: "result", result: "r1", error: "boom" },
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-underlying-during-return-2",
    helper: "flatMap",
    label: "Error in underlying during return 2",
    description: "As in <a href=\"#flatmap-error-in-underlying-during\">Error in underlying during return</a>, except that the error must be held until an earlier value resolves. The call to <code>result.return()</code> can settle immediately, however, because now we know that neither the underlying nor the inner iterator will need to be closed.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "return", result: "ret" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", error: "boom" },
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
            { type: "result", result: "r1", error: "boom" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-mapper-during-return",
    helper: "flatMap",
    label: "Error in mapper during return",
    description: "Like <a href=\"#flatmap-error-in-underlying-during\">Error in underlying during return</a>, but the error happens in the mapper. In this case <code>underlying.return()</code> must be called, and it blocks the Promise for <code>result.return()</code>.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "return", result: "ret" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", error: "boom" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", value: "a0" },
            { type: "result", result: "r0", value: "a0", from: "a0" },
            { type: "result", result: "r1", error: "boom" },
          ],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-active-iterator",
    helper: "flatMap",
    label: "Error in active inner",
    description: "An error in the active inner iterator closes the underlying iterator. The result Promise where the error will ultimately land is held until closing finishes.",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", error: "boom" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "r0", error: "boom" },
          ],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-non-active-iterator",
    helper: "flatMap",
    label: "Error in non-active inner",
    description: "An error in a no-longer-active inner iterator closes both the active inner iterator and the underlying iterator (sequentially).",
    ticks: [
      { steps: [
        {
          events: [],
        },
        {
          events: [
            { type: "next", result: "r0" },
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "next", result: "r1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "b0", value: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "a0", error: "boom" },
          ],
        },
        {
          caption: "Because the error will occupy a slot, we now know where the queued value will land, and can resolve a <code>result.next()</code> pull with that value. We also trigger a call of <code>inner.return()</code>; the Error cannot land until this and the subsequent call to <code>underlying.return()</code> settle.",
          events: [
            { type: "close", target: "B" },
            { type: "result", result: "r1", value: "b0", from: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "B" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "r0", error: "boom" },
          ],
        },
      ] },
    ],
  },
];

// The map animations, as scenarios (see ./FORMAT.md); index.html compiles
// them to step timelines at load. Converted (2026-06-09) from the former
// hand-written map-animations.js, since deleted along with the converter:
// this file is the source of truth — edit it by hand (same-tick event-order
// fixes in particular are expected).

// (header comment carried over from the original map-animations.js:)
/* ----------------------------------------------------------------
   Map animations. Same machinery as filter-scenarios.js (see
   FORMAT.md), but the Internal column runs a mapper
   `f` instead of a predicate: its box shows `f(A)` over the
   computed result `fA` (no true/false), and every value is
   forwarded — map never drops anything, so there is no compaction.
   ---------------------------------------------------------------- */

export const mapScenarios = [
  {
    id: "map-non-concurrent",
    helper: "map",
    label: "Simple non-concurrent",
    description: "Arrows or buttons at the bottom to navigate, alt-arrow to switch to other animations, click the names of the other helpers at the top for theirs. Dots indicate where some external-to-the-machinery action is about to occur.<br><br>This is a baseline for <code>map</code> with no concurrency. It works like you'd expect.",
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
          caption: "Request is forwarded to underlying. This happens same tick. Animations will often split one tick across multiple animation steps for expository reasons.",
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
            { type: "fn-settle", call: "p0", value: "fA" },
          ],
        },
        {
          events: [
            { type: "result", result: "r0", value: "fA", from: "p0" },
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
            { type: "fn-settle", call: "p1", value: "fB" },
            { type: "result", result: "r1", value: "fB", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-concurrent",
    helper: "map",
    label: "Simple concurrent*",
    description: "The distinguishing feature is that the consumer can call <code>result.next()</code> again before previous calls have resolved.<br><br>For <code>map</code>, uniquely, we can deliver values as they settle. <strong>Open question</strong>: should we?",
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
            { type: "next", result: "r1" },
          ],
        },
        {
          events: [
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
            { type: "fn-settle", call: "p1", value: "fB" },
            { type: "result", result: "r1", value: "fB", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-exhaustion",
    helper: "map",
    label: "Exhaustion",
    description: "Values are now shown as full iterator records (<code>done</code>/<code>value</code>). Here, the underlying iterator returns <code>done: true</code> on its second pull. This does not discard the earlier pull.",
    display: { records: true },
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
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", done: true },
          ],
        },
        {
          caption: "Even if we decide <code>map</code> should not deliver values in general out of order, it can still eagerly deliver <code>done: true</code> results specifically (and should do so for performance of <code>flatMap</code>).",
          events: [
            { type: "result", result: "r1", done: true },
          ],
        },
        {
          caption: "We internally track when iterators are closed, which we indicate with a 🪦 beside their column headers.",
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
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
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "You can continue to pull after the iterator is closed.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "But such pulls are not forwarded; they simply settle immediately with <code>done: true</code>.",
          events: [
            { type: "result", result: "r2", done: true },
          ],
        },
      ] },
    ],
  },
  {
    id: "map-exhaustion-2",
    helper: "map",
    label: "Exhaustion 2*",
    description: "It is possible for the underlying iterator to be <em>incoherent</em>, that is, to produce a <code>done: false</code> after a <code>done: true</code>. For <code>map</code>, if multiple pulls are in flight, this can be observed.<br><br><strong>Open question</strong>: What should we do in this case? The other helpers would have settled the 3rd pull with <code>done: true</code>. My inclination is to make this an <code>unhandledrejection</code> event.",
    display: { records: true },
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
            { type: "pull", pull: "u1" },
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
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", done: true },
          ],
        },
        {
          events: [
            { type: "result", result: "r1", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
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
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p1", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", value: "fC" },
            { type: "result", result: "r2", value: "fC", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-exhaustion-3",
    helper: "map",
    label: "Exhaustion 3*",
    description: "As in <a href=\"#map-exhaustion-2\">Exhaustion 2</a>, but now the 3rd value has already settled when we get the <code>done: true</code> from the second.<br><br><strong>Open question</strong>: What should we do in this case? In this case we could reject the outstanding pull with an error, rather than needing an <code>unhandledrejection</code> event.",
    display: { records: true },
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
            { type: "pull", pull: "u1" },
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
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p1", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", value: "fC" },
            { type: "result", result: "r2", value: "fC", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", done: true },
          ],
        },
        {
          events: [
            { type: "result", result: "r1", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
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
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-closing",
    helper: "map",
    label: "Closing",
    description: "Consumers can also call <code>result.return()</code> concurrently with one or more calls to <code>result.next()</code>, which can be blocked either on the mapper or the underlying pull.",
    display: { records: true },
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
            { type: "pull", pull: "u1" },
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
        {
          caption: "Just in case you thought this diagram was too simple, here's the rest of it!",
          events: [
            { type: "open-closing" },
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
          caption: "Calling <code>result.return()</code> when not closed will forward the call to the underlying iterator, and will cause the iterator to be considered closed.",
          events: [
            { type: "close", target: "source" },
            { type: "tombstone", target: "result" },
            { type: "tombstone", target: "underlying" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Further calls to <code>result.next()</code> settle with <code>done: true</code>, even if the call to <code>result.return()</code> is not yet complete.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          events: [
            { type: "result", result: "r2", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
        {
          events: [
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Values from earlier calls can still be delivered.",
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
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
            { type: "fn-settle", call: "p1", value: "fB" },
            { type: "result", result: "r1", value: "fB", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-error-underlying",
    helper: "map",
    label: "Error in underlying",
    description: "An error while pulling from the underlying iterator causes it to be considered closed but as always does not prevent earlier calls from getting values.",
    display: { records: true },
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
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", error: "boom" },
          ],
        },
        {
          caption: "As with values, errors can be delivered eagerly.",
          arrows: [["U1","I1"],["I1","R1"]],
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
            { type: "result", result: "r1", error: "boom" },
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
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-error-mapper",
    helper: "map",
    label: "Error in mapper",
    description: "An error from the mapper function causes <code>underlying.return()</code> to be called, and the Promise for the value which errored does not settle until that call completes.",
    display: { records: true },
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
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
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
          caption: "Note that the outstanding <code>result.next()</code> Promise is not settled here.",
          events: [
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
        {
          caption: "Only now that <code>underlying.return()</code> has settled do we settle the Promise for this call to <code>result.next()</code> with the error.",
          arrows: [["I1","R1"]],
          events: [
            { type: "result", result: "r1", error: "boom" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-error-mapper-2",
    helper: "map",
    label: "Error in mapper 2",
    description: "As in <a href=\"#map-error-mapper\">Error in mapper</a>, but now we have a later outstanding Promise past the error. This case is not considered incoherent; we can deliver values past the error, although further requests are still settled immediately.",
    display: { records: true },
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
            { type: "pull", pull: "u1" },
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
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
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
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
        {
          arrows: [["I1","R1"]],
          events: [
            { type: "result", result: "r1", error: "boom" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p2", arg: "C", from: "u2" },
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
            { type: "result", result: "r3", done: true },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p2", value: "fC" },
            { type: "result", result: "r2", value: "fC", from: "p2" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
];

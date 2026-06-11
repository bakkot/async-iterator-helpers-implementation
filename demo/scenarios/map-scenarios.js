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
    description: "Arrows or buttons at the bottom to navigate, alt-arrow to switch to other animations, click the names of the other helpers at the top for theirs. Dots indicate where some external-to-the-machinery action is about to occur.<br><br>This is a baseline for <code>.map</code> with no concurrency. It works like you'd expect.",
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
    description: "The distinguishing feature is that the consumer can call <code>.next()</code> again before previous calls have resolved.<br><br>For <code>.map</code>, uniquely, we can deliver values as they settle. <strong>Open question</strong>: should we?",
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
          caption: "Even if we decide <code>.map</code> should not deliver values in general out of order, it can still eagerly deliver <code>done: true</code> results specifically.",
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
    description: "It is possible for the underlying iterator to be <em>incoherent</em>, that is, to produce a <code>done: false</code> after a <code>done: true</code>. For <code>.map</code>, if multiple pulls are in flight, this can be observed.<br><br><strong>Open question</strong>: What should we do in this case? The other helpers would have settled the 3rd pull with <code>done: true</code>. My inclination is to make this an <code>unhandledrejection</code> event.",
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
    description: "Consumers can also call <code>.return()</code> concurrently with one or more calls to <code>.next()</code>, which can be blocked either on the mapper or the underlying pull.",
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
          caption: "Calling <code>.return()</code> when not closed will forward the call to the underlying iterator, and will cause the iterator to be considered closed.",
          events: [
            { type: "close", target: "source" },
            { type: "tombstone", target: "result" },
            { type: "tombstone", target: "underlying" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Further calls to <code>.next()</code> settle with <code>done: true</code>, even if the call to <code>.return()</code> is not yet complete.",
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
    description: "TODO",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same concurrent consumer — but this time the overlap lands in the underlying pulls, and values arrive out of order.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. The request is <b>pending</b> on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. That request is now pending too.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting for the first to settle, the consumer calls <code>.next()</code> <i>again</i>. <b>Result</b> row 2 goes pending.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "A <i>second</i> pull is forwarded to <b>Underlying</b> — two requests are now in flight <b>concurrently</b>.",
          events: [
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>second</i> Underlying request settles first — but with an <b>error</b> instead of a value. The box settles red. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", error: "boom" },
          ],
        },
        {
          caption: "An error from the source <b>closes both iterators</b> — <b>Underlying</b> and <b>Result</b> get their tombstones. The error is forwarded into the second <b>Internal</b> row, which takes on the errored state, and on to the second <b>Result</b> row: the second <code>.next()</code> rejects with the error.",
          arrows: [["U1","I1"],["I1","R1"]],
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
            { type: "slot-error", pull: "u1" },
            { type: "result", result: "r1", error: "boom" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>first</i> Underlying request still settles normally — <code>A</code> arrives — and runs <code>f(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to <code>fA</code>, so the first <code>.next()</code> still delivers its value normally — <code>{ value: fA }</code> — even though the second already rejected.",
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
        {
          caption: "<code>fA</code> is delivered and the second <code>.next()</code> has rejected — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-error-mapper",
    helper: "map",
    label: "Error in mapper",
    description: "TODO",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same concurrent consumer — but this time the mapper itself throws.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. The request is <b>pending</b> on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. That request is now pending too.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting for the first to settle, the consumer calls <code>.next()</code> <i>again</i>. <b>Result</b> row 2 goes pending.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "A <i>second</i> pull is forwarded to <b>Underlying</b> — two requests are now in flight <b>concurrently</b>.",
          events: [
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>second</i> Underlying request settles first — <code>{ done: false, value: B }</code> arrives — and runs <code>f(B)</code> in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> <b>throws</b>. The mapper erroring settles that slot red — the same representation as an error from the source. But the error doesn’t reach the consumer yet: <code>map</code> first closes the source.",
          events: [
            { type: "fn-settle", call: "p0", error: "boom" },
          ],
        },
        {
          caption: "A mapper error also <b>closes both iterators</b> — <b>Underlying</b> and <b>Result</b> get their tombstones. The helper calls <code>underlying.return()</code> to close the source, but <i>not</i> <code>result.return()</code>.",
          events: [
            // { type: "open-closing" },
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>underlying.return()</code> settles with <code>{}</code> — the source is closed.",
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
        {
          caption: "Only now — after <code>underlying.return()</code> has settled — does the error reach the consumer: the <i>second</i> <code>.next()</code> rejects with the mapper error, without waiting on the first.",
          arrows: [["I1","R1"]],
          events: [
            { type: "result", result: "r1", error: "boom" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>first</i> Underlying request still settles normally — <code>A</code> arrives — and runs <code>f(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to <code>fA</code>, so the first <code>.next()</code> still delivers its value normally — <code>{ value: fA }</code> — even though the second already rejected.",
          events: [
            { type: "fn-settle", call: "p1", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p1" },
          ],
        },
        {
          caption: "<code>fA</code> is delivered and the second <code>.next()</code> has rejected with the mapper error — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-error-mapper-2",
    helper: "map",
    label: "Error in mapper 2",
    description: "TODO",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same concurrent consumer — but this time the mapper itself throws.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. The request is <b>pending</b> on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. That request is now pending too.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting for the first to settle, the consumer calls <code>.next()</code> <i>again</i>. <b>Result</b> row 2 goes pending.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "A <i>second</i> pull is forwarded to <b>Underlying</b> — two requests are now in flight <b>concurrently</b>.",
          events: [
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "TODO",
          events: [
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>second</i> Underlying request settles first — <code>{ done: false, value: B }</code> arrives — and runs <code>f(B)</code> in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> <b>throws</b>. The mapper erroring settles that slot red — the same representation as an error from the source. But the error doesn’t reach the consumer yet: <code>map</code> first closes the source.",
          events: [
            { type: "fn-settle", call: "p0", error: "boom" },
          ],
        },
        {
          caption: "A mapper error also <b>closes both iterators</b> — <b>Underlying</b> and <b>Result</b> get their tombstones. The helper calls <code>underlying.return()</code> to close the source, but <i>not</i> <code>result.return()</code>.",
          events: [
            { type: "open-closing" },
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>underlying.return()</code> settles with <code>{}</code> — the source is closed.",
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
        {
          caption: "Only now — after <code>underlying.return()</code> has settled — does the error reach the consumer: the <i>second</i> <code>.next()</code> rejects with the mapper error, without waiting on the others.",
          arrows: [["I1","R1"]],
          events: [
            { type: "result", result: "r1", error: "boom" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>first</i> Underlying request still settles normally — <code>A</code> arrives — and runs <code>f(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to <code>fA</code>, so the first <code>.next()</code> delivers its value normally — <code>{ value: fA }</code>.",
          events: [
            { type: "fn-settle", call: "p1", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p2", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(C)</code> resolves to <code>fC</code>, so the <i>third</i> <code>.next()</code> delivers <code>{ value: fC }</code>.",
          events: [
            { type: "fn-settle", call: "p2", value: "fC" },
            { type: "result", result: "r2", value: "fC", from: "p2" },
          ],
        },
        {
          caption: "The run is complete: the first and third <code>.next()</code> delivered <code>fA</code> and <code>fC</code>; the second rejected with the mapper error.",
          events: [],
        },
      ] },
    ],
  },
];

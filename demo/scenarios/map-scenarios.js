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
    description: "A baseline with no concurrency: the consumer calls <code>.next()</code>, waits for it to resolve, and only then calls again. At most one underlying pull and one mapper are ever in flight. The map pulls from the source, runs the mapper <code>f</code>, and forwards the mapped value <code>f(x)</code>. Unlike filter, every value passes through — nothing is dropped.",
    ticks: [
      { steps: [
        {
          caption: "Idle. The mapped iterator is wired up; the consumer hasn’t asked for anything yet.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. The request is <b>pending</b> — highlighted, but unsettled.",
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
          caption: "Underlying settles with value <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to <code>fA</code>.",
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
          ],
        },
        {
          caption: "Because <code>map</code> never drops a value, each result corresponds to exactly one element — so the mapped value is forwarded to <b>Result</b> the moment its mapper settles. The consumer’s <code>.next()</code> resolves with <code>{ value: fA, done: false }</code>.",
          events: [
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The consumer pulls again. A new request is <b>pending</b> on the second <b>Result</b> row.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "Result forwards the pull to the <b>Underlying</b> source for its next element. Pending.",
          events: [
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>B</code> and hands it to the <b>Internal</b> stage, which invokes <code>f(B)</code> — pending.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> resolves to <code>fB</code>, which is forwarded to the second <b>Result</b> row — the consumer’s second <code>.next()</code> resolves with <code>{ value: fB, done: false }</code>.",
          events: [
            { type: "fn-settle", call: "p1", value: "fB" },
            { type: "result", result: "r1", value: "fB", from: "p1" },
          ],
        },
        {
          caption: "Both results are delivered, in source order — <code>fA</code> then <code>fB</code> — and the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-concurrent",
    helper: "map",
    label: "Simple concurrent",
    description: "The consumer issues a second <code>.next()</code> before the first has resolved, so the map keeps two underlying pulls — and two mappers — running at once. Unlike filter, every element maps to exactly one result, so a result can resolve as soon as its <i>own</i> mapper settles — it need not wait for earlier ones. When a later value’s mapper settles first, that <code>.next()</code> resolves first too: delivery follows completion order, not source order.",
    ticks: [
      { steps: [
        {
          caption: "Idle. Same wiring as before — but this consumer won’t wait for one pull to finish before issuing the next.",
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
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes <code>f(A)</code> — pending while the mapper runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting for <code>f(A)</code> to settle, the consumer calls <code>.next()</code> <i>again</i>. <b>Result</b> row 2 goes pending.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "Result forwards a second pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>B</code> and runs <code>f(B)</code> in the second <b>Internal</b> row. Now <i>two mappers</i> are in flight <b>concurrently</b> — <code>f(A)</code> is still pending.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> resolves to <code>fB</code> first — even though <code>B</code> is the <i>second</i> element. No need to buffer: each result maps to exactly one element, so <code>fB</code> is delivered <i>immediately</i> — the <i>second</i> <code>.next()</code> resolves with <code>{ value: fB }</code> while the first is still pending.",
          events: [
            { type: "fn-settle", call: "p1", value: "fB" },
            { type: "result", result: "r1", value: "fB", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Later, <code>f(A)</code> resolves to <code>fA</code> and is forwarded to the first <b>Result</b> row — the first <code>.next()</code> resolves with <code>{ value: fA }</code>, <i>after</i> the second one already did.",
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
        {
          caption: "Both results are delivered — but in <b>completion order</b>, <code>fB</code> then <code>fA</code>, not source order. With <code>map</code>’s one-to-one correspondence each <code>.next()</code> resolves as soon as its own mapper does.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-truncation",
    helper: "map",
    label: "Truncation",
    description: "Values are now shown as full iterator records (<code>done</code>/<code>value</code>). While two pulls are in flight, the source runs out: a <code>{ done: true }</code> result passes straight through the map — the mapper never runs on it — and resolves the second pending <code>.next()</code>, even though the first is still waiting on <code>A</code>.",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Wired up like “Simple concurrent”, except each Underlying and Result value now shows its full iterator record — <code>done</code> and <code>value</code>.",
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
          caption: "The <i>second</i> Underlying request settles first with <code>{ done: true }</code> — the source is exhausted. There’s no value to map, so nothing enters the <b>Internal</b> buffer. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", done: true },
          ],
        },
        {
          caption: "That completion passes straight through, bypassing the mapper: the <i>second</i> pending <code>.next()</code> resolves, so <b>Result</b> row 2 settles with <code>{ done: true }</code>.",
          events: [
            { type: "result", result: "r1", done: true },
          ],
        },
        {
          caption: "The source is exhausted, so both iterators are now <b>closed</b> — marked with 🪦 beside their column headers.",
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Meanwhile the <i>first</i> Underlying request finally settles — <code>{ done: false, value: A }</code> — and runs <code>f(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to <code>fA</code>, which is forwarded to the first <b>Result</b> row — the first <code>.next()</code> settles with <code>{ done: false, value: fA }</code>.",
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The consumer pulls once more. <b>Result</b> row 3 goes pending.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "The iterator is already closed, so the pull settles immediately with <code>{ done: true }</code> — once exhausted, it keeps reporting done.",
          events: [
            { type: "result", result: "r2", done: true },
          ],
        },
      ] },
    ],
  },
  {
    id: "map-truncation-2",
    helper: "map",
    label: "Truncation 2",
    description: "A third <code>.next()</code> races the source running dry. The <code>{ done: true }</code> resolves the <i>second</i> call — but the first and third are each chained to their <i>own</i> still-outstanding pull, so they keep waiting. The slow <code>A</code> arrives and is mapped to <code>fA</code>; then the third pull settles with <code>C</code> — a value, after the source already reported done — which <code>map</code> runs through the mapper and delivers: the third call resolves <code>{ done: false, value: fC }</code> after the second already settled <code>{ done: true }</code>.<br><br><strong>Note</strong>: settling with a <code>done: false</code> after a <code>done: true</code> is unique to <code>map</code> and may be changed.",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same concurrent <code>map</code> as “Truncation”, but this consumer will pull a <i>third</i> time — and the slow first value races against the source running out.",
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
          caption: "The consumer calls <code>.next()</code> a <i>third</i> time — <b>Result</b> row 3 goes pending. The first two pulls are still unsettled.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "The map forwards a <i>third</i> pull to <b>Underlying</b> (row 3). Three pulls are now in flight at once — while <code>A</code>’s original request (row 1) is <i>still</i> outstanding.",
          events: [
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>second</i> pull settles with <code>{ done: true }</code> — the source is exhausted. There’s no value to map, so nothing enters the <b>Internal</b> buffer. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", done: true },
          ],
        },
        {
          caption: "The <i>second</i> <code>.next()</code> has nothing more coming, so <b>Result</b> row 2 settles with <code>{ done: true }</code>, and both iterators are now <b>closed</b> — marked with 🪦 beside their column headers. But rows 1 and 3 are each chained to their <i>own</i> still-outstanding pull, so they keep waiting.",
          events: [
            { type: "result", result: "r1", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "At last the row-1 pull settles — <code>{ done: false, value: A }</code> — and runs <code>f(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to <code>fA</code>, which is forwarded to the first <b>Result</b> row — the first <code>.next()</code> finally settles with <code>{ done: false, value: fA }</code>.",
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Long after the source reported <code>{ done: true }</code>, the <i>third</i> pull settles too — with a <i>value</i>: <code>{ done: false, value: C }</code>. <code>map</code> doesn’t track which pulls the completion superseded: the value is handed to the <b>Internal</b> stage and <code>f(C)</code> runs.",
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p1", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(C)</code> resolves to <code>fC</code>, which is forwarded to the third <b>Result</b> row: the third <code>.next()</code> settles with <code>{ done: false, value: fC }</code> — a value, <i>after</i> the second <code>.next()</code> already reported <code>{ done: true }</code>.",
          events: [
            { type: "fn-settle", call: "p1", value: "fC" },
            { type: "result", result: "r2", value: "fC", from: "p1" },
          ],
        },
        {
          caption: "All three results are delivered: <code>fA</code>, then <code>{ done: true }</code>, then <code>fC</code> — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "map-closing",
    helper: "map",
    label: "Closing",
    description: "TODO",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle.",
          events: [],
        },
        {
          caption: "TODO",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "TODO",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "TODO",
          events: [
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
        {
          caption: "The diagram shifts down and the <code>underlying.return()</code> / <code>result.return()</code> columns slide in above.",
          events: [
            { type: "open-closing" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "return", result: "ret" },
          ],
        },
        {
          caption: "TODO",
          events: [
            { type: "tombstone", target: "result" },
          ],
        },
        {
          caption: "TODO",
          events: [
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
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
            { type: "result", result: "r2", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
        {
          caption: "TODO",
          events: [
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "fn-settle", call: "p0", value: "fA" },
            { type: "result", result: "r0", value: "fA", from: "p0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "TODO",
          events: [
            { type: "fn-settle", call: "p1", value: "fB" },
            { type: "result", result: "r1", value: "fB", from: "p1" },
          ],
        },
        {
          caption: "TODO",
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

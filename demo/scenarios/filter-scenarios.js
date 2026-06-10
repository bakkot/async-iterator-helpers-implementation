// The filter animations, as scenarios (see ./FORMAT.md); index.html compiles
// them to step timelines at load. Converted (2026-06-09) from the former
// hand-written filter-animations.js, since deleted along with the converter:
// this file is the source of truth — edit it by hand (same-tick event-order
// fixes in particular are expected).

// (header comment carried over from the original filter-animations.js:)
/* ----------------------------------------------------------------
   The timeline. Each step is a list of [selector, spec] operations
   that transition the diagram from the previous step into this one.
   `spec` is space-separated tokens: "+cls" adds a class, "-cls"
   removes it. These are the ONLY classes JS ever touches, so a
   render can rebuild any step from scratch by replaying steps 1..n.

   Convention used below:
     box:  +pending          (a request goes out / work starts)
           -pending +settled (it resolves, holding its value)
     text/arrow: +reveal     (a value/label/arrow fades in)
     group: +gone            (a rejected computation fades out)
            +slide-up        (a slot climbs one row)
            +slide-in        (the parked spare slides into view)
   ---------------------------------------------------------------- */

export const filterScenarios = [
  // text baked into each box, keyed by group id then by text-class.
  // Applied (and revealed via the .reveal class in the steps) per animation.
  {
    id: "filter-non-concurrent",
    helper: "filter",
    label: "Simple non-concurrent",
    description: "A baseline with no concurrency: the consumer calls <code>.next()</code>, waits for it to resolve, and only then calls again. At most one underlying pull and one predicate are ever in flight. The filter pulls from the source, runs the predicate, and forwards values that pass — rejected values are skipped over before the call resolves.",
    ticks: [
      { steps: [
        {
          caption: "Idle. The filtered iterator is wired up; the consumer hasn’t asked for anything yet.",
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
          caption: "Underlying settles with value <code>A</code> and hands it to the <b>Internal</b> stage, which invokes <code>pred(A)</code> — pending while the predicate runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(A)</code> settles to <code>true</code>, so <code>A</code> passes the filter and is forwarded to <b>Result</b>, which settles — the consumer’s <code>.next()</code> resolves with <code>{ value: A, done: false }</code>.",
          events: [
            { type: "fn-settle", call: "p0", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p0" },
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
          caption: "Underlying settles with <code>B</code> and hands it to the <b>Internal</b> stage, which invokes <code>pred(B)</code> — pending.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>false</code>. <code>B</code> is rejected, so it is <i>not</i> forwarded — no arrow to Result.",
          events: [
            { type: "fn-settle", call: "p1", verdict: false },
          ],
        },
        {
          caption: "<code>B</code> is discarded: the <code>pred(B)</code> box drops out of the <b>Internal</b> column, which compacts upward as a fresh slot slides in. In the same beat the filter pulls again — <b>Underlying</b> row 3 lights up <b>pending</b>. (<b>Underlying</b> keeps <code>A</code> and <code>B</code>.)",
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>C</code>. Because <code>B</code> was filtered out, <code>C</code> feeds the <i>second</i> Internal row — note the diagonal arrow — where <code>pred(C)</code> runs, pending.",
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p2", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(C)</code> settles to <code>true</code>, so <code>C</code> passes the filter and is forwarded to the second <b>Result</b> row, which settles — the consumer’s second <code>.next()</code> resolves with <code>{ value: C, done: false }</code>.",
          events: [
            { type: "fn-settle", call: "p2", verdict: true },
            { type: "result", result: "r1", value: "C", from: "p2" },
          ],
        },
        {
          caption: "Both results are delivered, in source order — <code>A</code> then <code>C</code> — and the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-concurrent",
    helper: "filter",
    label: "Simple concurrent",
    description: "The consumer issues a second <code>.next()</code> before the first has resolved, so the filter keeps two underlying pulls — and two predicates — running at once. Even when a later value’s predicate settles first, results are still delivered to the consumer in source order, so an early arrival is buffered until its predecessors are ready.",
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
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes <code>pred(A)</code> — pending while the predicate runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting for <code>pred(A)</code> to settle, the consumer calls <code>.next()</code> <i>again</i>. <b>Result</b> row 2 goes pending.",
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
          caption: "Underlying settles with <code>B</code> and runs <code>pred(B)</code> in the second <b>Internal</b> row. Now <i>two predicates</i> are in flight <b>concurrently</b> — <code>pred(A)</code> is still pending.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>true</code> first, so <code>B</code> passes. But it <i>can’t</i> be delivered yet: the first <code>.next()</code> must resolve with the first passing value in source order, and <code>pred(A)</code> is still pending. <code>B</code> waits, buffered.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
          ],
        },
        {
          caption: "Now <code>pred(A)</code> settles to <code>true</code> as well — <code>A</code> passes too.",
          events: [
            { type: "fn-settle", call: "p0", verdict: true },
          ],
        },
        {
          caption: "Both pending results resolve, in source order: <code>A</code> satisfies the first <code>.next()</code>, <code>B</code> the second. Both <b>Result</b> rows settle together — <code>{ value: A }</code> then <code>{ value: B }</code>.",
          events: [
            { type: "result", result: "r0", value: "A", from: "p0" },
            { type: "result", result: "r1", value: "B", from: "p1" },
          ],
        },
        {
          caption: "Both results are delivered, in source order — <code>A</code> then <code>B</code> — and the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-concurrent-2",
    helper: "filter",
    label: "Simple concurrent 2",
    description: "Like the concurrent case, but the overlap lands in the underlying pulls and values arrive out of order: <code>B</code> comes back before <code>A</code> and fails the predicate. The filter discards it and pulls again to keep two requests in flight, while the slow <code>A</code> is still outstanding — yet the results are ultimately delivered in source order.",
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
          caption: "The <i>second</i> Underlying request settles first: <code>B</code> arrives before <code>A</code>. It runs <code>pred(B)</code> in the second <b>Internal</b> row. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>false</code> — <code>B</code> is rejected.",
          events: [
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          caption: "<code>B</code> is discarded and <b>Internal</b> compacts upward. To keep two pulls in flight, the filter issues a fresh <b>Underlying</b> pull (row 3) — and <code>A</code>’s request is <i>still</i> pending.",
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>C</code> — still ahead of <code>A</code>. The diagonal hands it to the second <b>Internal</b> row, where <code>pred(C)</code> runs.",
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p1", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(C)</code> settles to <code>true</code>, so <code>C</code> passes. But it <i>can’t</i> be delivered yet: the first <code>.next()</code> must resolve with the first passing value in source order, and <code>A</code> is still pending. <code>C</code> waits, buffered.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
          ],
        },
        {
          caption: "At last the <i>first</i> Underlying request settles — <code>A</code> arrives, last of all — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p2", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(A)</code> settles to <code>true</code> — <code>A</code> passes too. Now both pending results resolve, in source order: <code>A</code> satisfies the first <code>.next()</code>, <code>C</code> the second. Both <b>Result</b> rows settle together — <code>{ value: A }</code> then <code>{ value: C }</code>.",
          events: [
            { type: "fn-settle", call: "p2", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p2" },
            { type: "result", result: "r1", value: "C", from: "p1" },
          ],
        },
        {
          caption: "Both results are delivered, in source order — <code>A</code> then <code>C</code> — and the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-concurrent-3",
    helper: "filter",
    label: "Simple concurrent 3",
    description: "A longer concurrent run where the first value also fails: both <code>A</code> and <code>B</code> are rejected. The buffered <code>C</code> shifts up to satisfy the first <code>.next()</code> once <code>A</code> is known to be filtered out, and a fresh pull yields <code>D</code> for the second — showing how the buffer re-targets pending results as values drop out.",
    ticks: [
      { steps: [
        {
          caption: "Idle. The same concurrent setup as before — but this time <code>pred(A)</code> will end up <i>false</i>.",
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
          caption: "The <i>second</i> Underlying request settles first: <code>B</code> arrives before <code>A</code>. It runs <code>pred(B)</code> in the second <b>Internal</b> row. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>false</code> — <code>B</code> is rejected.",
          events: [
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          caption: "<code>B</code> is discarded and <b>Internal</b> compacts upward. To keep two pulls in flight, the filter issues a fresh <b>Underlying</b> pull (row 3) — and <code>A</code>’s request is <i>still</i> pending.",
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>C</code> — still ahead of <code>A</code>. The diagonal hands it to the second <b>Internal</b> row, where <code>pred(C)</code> runs.",
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p1", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(C)</code> settles to <code>true</code>, so <code>C</code> passes. But it <i>can’t</i> be delivered yet: the first <code>.next()</code> must resolve with the first passing value in source order, and <code>A</code> is still pending. <code>C</code> waits, buffered.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
          ],
        },
        {
          caption: "At last the <i>first</i> Underlying request settles — <code>A</code> arrives, last of all — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p2", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "This time <code>pred(A)</code> settles to <code>false</code> — <code>A</code> is rejected, just like <code>B</code> was.",
          events: [
            { type: "fn-settle", call: "p2", verdict: false },
          ],
        },
        {
          caption: "<code>A</code> is discarded and <b>Internal</b> compacts upward again — the buffered <code>pred(C)</code> result climbs into the <i>first</i> row. <code>C</code> is now the first surviving value, so it resolves the <i>first</i> <code>.next()</code>: <b>Result</b> row 1 settles with <code>C</code>. The second pull is still unfilled, so the filter issues a fresh <b>Underlying</b> pull.",
          events: [
            { type: "compact", pull: "u0" },
            { type: "pull", pull: "u3" },
            { type: "result", result: "r0", value: "C", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "That pull settles with <code>D</code>. The next free <b>Internal</b> row (row 2) runs <code>pred(D)</code> — the diagonal shows it landing below the surviving <code>C</code>.",
          events: [
            { type: "settle", pull: "u3", value: "D" },
            { type: "fn", call: "p3", arg: "D", from: "u3" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(D)</code> settles to <code>true</code>, so <code>D</code> passes and resolves the still-pending <i>second</i> <code>.next()</code> — <b>Result</b> row 2 settles with <code>D</code>.",
          events: [
            { type: "fn-settle", call: "p3", verdict: true },
            { type: "result", result: "r1", value: "D", from: "p3" },
          ],
        },
        {
          caption: "Both results are delivered, in source order — <code>C</code> then <code>D</code> — and the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-truncation",
    helper: "filter",
    label: "Truncation",
    description: "Values are now shown as full iterator records (<code>done</code>/<code>value</code>). While two pulls are in flight, the source runs out: a <code>{ done: true }</code> result passes straight through the filter — the predicate never runs on it — and resolves the second pending <code>.next()</code>, even though the first is still waiting on <code>A</code>.",
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
          caption: "The <i>second</i> Underlying request settles first: <code>B</code> arrives before <code>A</code>. It runs <code>pred(B)</code> in the second <b>Internal</b> row. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>false</code> — <code>B</code> is rejected.",
          events: [
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          caption: "<code>B</code> is discarded and <b>Internal</b> compacts upward. To keep two pulls in flight, the filter issues a fresh <b>Underlying</b> pull (row 3) — and <code>A</code>’s request is <i>still</i> pending.",
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The third Underlying pull settles with <code>{ done: true }</code> — the source is exhausted. There’s no value to test, so nothing enters the <b>Internal</b> buffer.",
          events: [
            { type: "settle", pull: "u2", done: true },
          ],
        },
        {
          caption: "That completion passes straight through, bypassing the filter: the <i>second</i> pending <code>.next()</code> resolves, so <b>Result</b> row 2 settles with <code>{ done: true }</code>.",
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
          caption: "Meanwhile the <i>first</i> Underlying request finally settles — <code>{ done: false, value: A }</code> — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(A)</code> settles to <code>true</code>, so <code>A</code> passes the filter and resolves the first <code>.next()</code> — <b>Result</b> row 1 settles with <code>{ done: false, value: A }</code>.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
          ],
        },
        {
          caption: "Both results are delivered, in source order — <code>{ done: false, value: A }</code> then <code>{ done: true }</code> — and the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-truncation-2",
    helper: "filter",
    label: "Truncation 2",
    description: "Same exhaustion, but the last live value <code>A</code> fails the predicate. With nothing left to pull, the first <code>.next()</code> has no value to deliver, so it too completes with <code>{ done: true }</code> — sourced from the exhausted iterator itself, not from any predicate, so no arrow flows into it.",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same setup as “Truncation” — full iterator records — but this time the last live value will <i>fail</i> the predicate, with the source already exhausted.",
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
          caption: "The <i>second</i> Underlying request settles first: <code>B</code> arrives before <code>A</code>. It runs <code>pred(B)</code> in the second <b>Internal</b> row. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>false</code> — <code>B</code> is rejected.",
          events: [
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          caption: "<code>B</code> is discarded and <b>Internal</b> compacts upward. To keep two pulls in flight, the filter issues a fresh <b>Underlying</b> pull (row 3) — and <code>A</code>’s request is <i>still</i> pending.",
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The third Underlying pull settles with <code>{ done: true }</code> — the source is exhausted. There’s no value to test, so nothing enters the <b>Internal</b> buffer.",
          events: [
            { type: "settle", pull: "u2", done: true },
          ],
        },
        {
          caption: "That completion passes straight through, bypassing the filter: the <i>second</i> pending <code>.next()</code> resolves, so <b>Result</b> row 2 settles with <code>{ done: true }</code>. The source is exhausted, so both iterators are now <b>closed</b> — marked with 🪦 beside their column headers.",
          events: [
            { type: "result", result: "r1", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Meanwhile the <i>first</i> Underlying request finally settles — <code>{ done: false, value: A }</code> — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "This time <code>pred(A)</code> settles to <code>false</code> — <code>A</code> is rejected. It was the last live value, and the source is already exhausted.",
          events: [
            { type: "fn-settle", call: "p1", verdict: false },
          ],
        },
        {
          caption: "With <code>A</code> filtered out and nothing left to pull, the first <code>.next()</code> has no value to deliver — so it completes. <b>Result</b> row 1 settles with <code>{ done: true }</code>. The completion comes from the exhausted source, not a predicate, so there’s no arrow into it.",
          events: [
            { type: "result", result: "r0", done: true },
          ],
        },
      ] },
    ],
  },
  {
    id: "filter-truncation-3",
    helper: "filter",
    label: "Truncation 3",
    description: "A third <code>.next()</code> races the source running dry. Once the source is exhausted, an outstanding pull that can never yield a value is <span style=\"color:#8b5cf6\">voided</span>, and the second and third calls complete with <code>{ done: true }</code> — while the first is still waiting on the slow <code>A</code>, which ultimately passes the predicate and resolves last.<br><br><strong>Open question</strong>: What happens to that purple Promise if it ends up being something other than \"done: true\"?",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same concurrent <code>filter</code> as “Truncation”, but this consumer will pull a <i>third</i> time — and the slow first value races against the source running out.",
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
          caption: "The <i>second</i> Underlying request settles first: <code>B</code> arrives before <code>A</code>. It runs <code>pred(B)</code> in the second <b>Internal</b> row. (<code>A</code>’s request is still outstanding.)",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>false</code> — <code>B</code> is rejected.",
          events: [
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          caption: "<code>B</code> is discarded and <b>Internal</b> compacts upward. To keep two pulls in flight, the filter issues a fresh <b>Underlying</b> pull (row 3) — and <code>A</code>’s request is <i>still</i> pending.",
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
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
          caption: "The filter forwards another pull to <b>Underlying</b> (row 4). Three pulls are now in flight at once — rows 1, 3 and 4 — while <code>A</code>’s original request (row 1) is <i>still</i> outstanding.",
          events: [
            { type: "pull", pull: "u3" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The row-3 pull settles with <code>{ done: true }</code> — the source is exhausted. There’s no value to test, so nothing enters the <b>Internal</b> buffer.",
          events: [
            { type: "settle", pull: "u2", done: true },
          ],
        },
        {
          caption: "With the source finished, the still-outstanding row-4 pull can never yield a value — it’s superseded by the completion (marked <span style=\"color:#8b5cf6\">purple</span>). The 2nd and 3rd <code>.next()</code> calls have nothing more coming, so <b>Result</b> rows 2 and 3 settle with <code>{ done: true }</code> — even though row 1 is still waiting on <code>A</code>. The source is exhausted, so both iterators are now <b>closed</b> — marked with 🪦 beside their column headers.",
          events: [
            { type: "void", pull: "u3" },
            { type: "result", result: "r1", done: true },
            { type: "result", result: "r2", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "At last the row-1 pull settles — <code>{ done: false, value: A }</code> — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(A)</code> settles to <code>true</code>, so <code>A</code> passes the filter, and the first <code>.next()</code> finally resolves — <b>Result</b> row 1 settles with <code>{ done: false, value: A }</code>.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
          ],
        },
        {
          caption: "All three results are delivered, in source order — <code>{ done: false, value: A }</code> then <code>{ done: true }</code> twice — and the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-truncation-4",
    helper: "filter",
    label: "Truncation 4",
    description: "A concurrent run where the first value <code>B</code> fails the predicate; after compaction a second pull races a fresh <code>.next()</code>. This time the source has <i>not</i> run dry — the third pull (row 3) comes back with a live value <code>D</code>.",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. A concurrent <code>filter</code>: the first value will fail the predicate, and a later pull returns a live value.",
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
          caption: "Underlying settles with <code>B</code> and hands it to the <b>Internal</b> stage, which invokes <code>pred(B)</code> — pending while the predicate runs.",
          events: [
            { type: "settle", pull: "u0", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> settles to <code>false</code> — <code>B</code> is rejected.",
          events: [
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          caption: "<code>B</code> is discarded and <b>Internal</b> compacts upward. The filter issues a fresh <b>Underlying</b> pull (row 2) to keep looking for a passing value.",
          events: [
            { type: "compact", pull: "u0" },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The consumer calls <code>.next()</code> a <i>second</i> time — <b>Result</b> row 2 goes pending.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "The filter forwards another pull to <b>Underlying</b> (row 3). Two pulls are now in flight at once — rows 2 and 3.",
          events: [
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The row-3 pull settles with a live value — <code>{ done: false, value: D }</code> — not exhaustion. It feeds the second <b>Internal</b> row (note the diagonal), where <code>pred(D)</code> runs, pending.",
          events: [
            { type: "settle", pull: "u2", value: "D" },
            { type: "fn", call: "p1", arg: "D", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(D)</code> settles to <code>true</code>, so <code>D</code> passes the filter.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
          ],
        },
        {
          caption: "But before <code>D</code> can be delivered, the row-2 pull settles with <code>{ done: true }</code> — the source is exhausted, and it was earlier in source order than <code>D</code>.",
          events: [
            { type: "settle", pull: "u1", done: true },
          ],
        },
        {
          caption: "The source is exhausted before <code>D</code>’s slot in source order, so both pending <code>.next()</code> calls complete with <code>{ done: true }</code> — <b>Result</b> rows 1 and 2 settle. The empty slot for the exhausted pull is discarded and <b>Internal</b> compacts upward, leaving the passing <code>pred(D)</code> result undeliverable — it’s <span style=\"color:#8b5cf6\">voided</span>. Because it had already settled, it carries no highlight; it just turns purple. The source is exhausted, so both iterators are now <b>closed</b> — marked with 🪦 beside their column headers.",
          events: [
            { type: "void", call: "p1" },
            { type: "compact", pull: "u1" },
            { type: "result", result: "r0", done: true },
            { type: "result", result: "r1", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
      ] },
    ],
  },
  {
    id: "filter-closing",
    helper: "filter",
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
            { type: "fn-settle", call: "p0", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p0" },
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
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r1", value: "B", from: "p1" },
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
    id: "filter-closing-2",
    helper: "filter",
    label: "Closing 2",
    description: "Like “Closing”, but <code>pred(B)</code> settles to <code>false</code>. Because the iterator was already closed by <code>.return()</code>, <code>filter</code> does <i>not</i> issue another <b>Underlying</b> pull to replace the rejected value — the outstanding <code>.next()</code> simply completes with <code>{ done: true }</code>.<br><br><strong>Open question</strong>: does .return [todo styling] indicate only that we will no longer request _new_ values, or also that we don't care about _outstanding_ pulls?",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same as “Closing” — the consumer pulls twice, then calls <code>.return()</code> mid-flight — but this time <code>B</code> will <i>fail</i> the predicate.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator — row 1 goes <b>pending</b>.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting, the consumer calls <code>.next()</code> again — <b>Result</b> row 2 goes pending.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "A second pull is forwarded to <b>Underlying</b> — two requests are in flight <b>concurrently</b>.",
          events: [
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The first Underlying request settles — <code>A</code> — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
        {
          caption: "The consumer calls <code>.return()</code> on the <b>Result</b> iterator. The diagram shifts down and the <code>underlying.return()</code> / <code>result.return()</code> columns slide in above.",
          events: [
            { type: "open-closing" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>result.return()</code> is invoked — pending.",
          events: [
            { type: "return", result: "ret" },
          ],
        },
        {
          caption: "The <b>Result</b> iterator is now <b>closed</b> — marked with 🪦 beside its header.",
          events: [
            { type: "tombstone", target: "result" },
          ],
        },
        {
          caption: "<code>filter</code> forwards the close to the source: <code>underlying.return()</code> is invoked — pending — and the <b>Underlying</b> iterator is closed too — 🪦.",
          events: [
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "A pull made after <code>.return()</code> resolves immediately — <b>Result</b> row 3 goes pending.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "It settles with <code>{ done: true }</code> — the iterator is closed.",
          events: [
            { type: "result", result: "r2", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>underlying.return()</code> settles with <code>{}</code>.",
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
        {
          caption: "<code>result.return()</code> settles with <code>{}</code>.",
          events: [
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Meanwhile the in-flight work still completes: <code>pred(A)</code> settles <code>true</code>, so the first <code>.next()</code> delivers <code>A</code> to <b>Result</b> row 1.",
          events: [
            { type: "fn-settle", call: "p0", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "And the second Underlying request settles — <code>B</code> — running <code>pred(B)</code> in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "This time <code>pred(B)</code> settles to <code>false</code> — <code>B</code> is rejected.",
          events: [
            { type: "fn-settle", call: "p1", verdict: false },
          ],
        },
        {
          caption: "Normally a rejected value would make <code>filter</code> pull <b>Underlying</b> again to find the next passing value. But the iterator has already been <b>closed</b>, so <b>no further pull is issued</b>. With nothing left to deliver, the second <code>.next()</code> completes: <b>Result</b> row 2 settles with <code>{ done: true }</code> — no arrow, since the completion comes from the closed source, not a predicate.",
          events: [
            { type: "compact", pull: "u1" },
            { type: "result", result: "r1", done: true },
          ],
        },
        {
          caption: "Done.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-error-underlying",
    helper: "filter",
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
          caption: "An error from the source <b>closes both iterators</b> — <b>Underlying</b> and <b>Result</b> get their tombstones. The error is forwarded into the second <b>Internal</b> row, which takes on the errored state.",
          arrows: [["U1","I1"]],
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
            { type: "slot-error", pull: "u1" },
          ],
        },
        {
          caption: "The <i>first</i> Underlying request still settles normally — <code>A</code> arrives — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(A)</code> settles to <code>true</code>, so <code>A</code> satisfies the first <code>.next()</code> — <b>Result</b> row 1 delivers <code>{ value: A }</code>. The second <code>.next()</code>, however, rejects with the error.",
          arrows: [["I0","R0"],["I1","R1"]],
          events: [
            { type: "fn-settle", call: "p0", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p0" },
            { type: "result", result: "r1", error: "boom" },
          ],
        },
        {
          caption: "<code>A</code> is delivered and the second <code>.next()</code> has rejected — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-error-predicate",
    helper: "filter",
    label: "Error in predicate",
    description: "TODO",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same concurrent consumer — but this time the predicate itself throws.",
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
          caption: "The <i>second</i> Underlying request settles first — <code>{ done: false, value: B }</code> arrives — and runs <code>pred(B)</code> in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> <b>throws</b>. The predicate erroring settles that slot red — the same representation as an error from the source.",
          events: [
            { type: "fn-settle", call: "p0", error: "boom" },
          ],
        },
        {
          caption: "A predicate error <b>closes both iterators</b> — <b>Underlying</b> and <b>Result</b> get their tombstones. The helper calls <code>underlying.return()</code> to close the source, but <i>not</i> <code>result.return()</code> — the error simply propagates out to the consumer.",
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
      ] },
      { steps: [
        {
          caption: "The <i>first</i> Underlying request still settles normally — <code>A</code> arrives — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(A)</code> settles to <code>true</code>, so the first <code>.next()</code> delivers <code>{ value: A }</code> — while the second <code>.next()</code> rejects with the predicate error.",
          arrows: [["I0","R0"],["I1","R1"]],
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
            { type: "result", result: "r1", error: "boom" },
          ],
        },
        {
          caption: "<code>A</code> is delivered and the second <code>.next()</code> has rejected with the predicate error — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-error-predicate-2",
    helper: "filter",
    label: "Error in predicate 2",
    description: "TODO",
    display: { records: true },
    ticks: [
      { steps: [
        {
          caption: "Idle. Same concurrent consumer — but this time the predicate itself throws.",
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
          caption: "The <i>second</i> Underlying request settles first — <code>{ done: false, value: B }</code> arrives — and runs <code>pred(B)</code> in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(B)</code> <b>throws</b>. The predicate erroring settles that slot red — the same representation as an error from the source.",
          events: [
            { type: "fn-settle", call: "p0", error: "boom" },
          ],
        },
        {
          caption: "A predicate error <b>closes both iterators</b> — <b>Underlying</b> and <b>Result</b> get their tombstones. The helper calls <code>underlying.return()</code> to close the source, but <i>not</i> <code>result.return()</code> — the error simply propagates out to the consumer.",
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
      ] },
      { steps: [
        {
          caption: "The <i>first</i> Underlying request still settles normally — <code>A</code> arrives — and runs <code>pred(A)</code> in the first <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>pred(A)</code> settles to <code>true</code>, so the first <code>.next()</code> delivers <code>{ value: A }</code> — while the second <code>.next()</code> rejects with the predicate error.",
          arrows: [["I0","R0"],["I1","R1"]],
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
            { type: "result", result: "r1", error: "boom" },
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
          caption: "TODO",
          events: [
            { type: "fn-settle", call: "p2", verdict: true },
            { type: "result", result: "r2", value: "C", from: "p2" },
          ],
        },
        {
          caption: "<code>A</code> is delivered and the second <code>.next()</code> has rejected with the predicate error — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
];

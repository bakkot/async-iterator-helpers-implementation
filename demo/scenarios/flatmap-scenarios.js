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
    description: "A baseline with no concurrency. <code>flatMap</code> maps each source value to an (async) <i>iterator</i> and yields every one of that iterator’s values before moving on to the next source value. When the mapper <code>f(x)</code> settles, its <b>Internal</b> box is replaced by the inner iterator it returned — drawn as its own little row of pulls. Here the source is <code>[A, B]</code>; <code>f(A)</code> yields <code>[a1, a2]</code> and <code>f(B)</code> yields <code>[b1]</code>, so the flattened result is <code>a1, a2, b1</code>.",
    ticks: [
      { steps: [
        {
          caption: "Idle. <code>flatMap</code> maps each source value to an (async) <i>iterator</i>, then yields all of that iterator’s values before moving on. This consumer is non-concurrent: it waits for each <code>.next()</code> to resolve before calling again.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. The request is <b>pending</b> on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves — not to a value, but to an <i>inner async iterator</i>. Its box is <b>replaced</b> by that iterator, drawn as its own little run of pulls (the smaller boxes). Nothing has been pulled from it yet.",
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "To satisfy the outstanding <code>.next()</code>, <code>flatMap</code> pulls the inner iterator’s first value — <b>pending</b>.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The inner iterator yields <code>a1</code>, forwarded straight through to <b>Result</b>: the first <code>.next()</code> resolves with <code>{ value: a1 }</code>.",
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Consumer pulls again. <b>Result</b> row 2 goes pending.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "The current inner iterator isn’t exhausted, so <code>flatMap</code> stays with it and pulls its <i>next</i> value — no new <b>Underlying</b> pull. Pending.",
          events: [
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "It yields <code>a2</code>, forwarded to <b>Result</b>: the second <code>.next()</code> resolves with <code>{ value: a2 }</code>.",
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Consumer pulls a third time. <b>Result</b> row 3 goes pending.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "<code>flatMap</code> pulls the inner iterator once more — pending.",
          events: [
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "This time the inner iterator is <b>exhausted</b> (<code>{ done: true }</code>). That <code>done</code> is <i>not</i> forwarded — instead <code>flatMap</code> moves on to the next source value, forwarding a fresh pull to <b>Underlying</b>. The third <code>.next()</code> is still pending.",
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>B</code>; the mapper <code>f(B)</code> runs in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> resolves to a second inner iterator, which replaces its mapper box.",
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          caption: "<code>flatMap</code> pulls the new inner iterator’s first value — pending.",
          events: [
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "It yields <code>b1</code>, which finally resolves the third <code>.next()</code> — <code>{ value: b1 }</code>.",
          events: [
            { type: "settle", pull: "b0", value: "b1" },
            { type: "result", result: "r2", value: "b1", from: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Consumer pulls once more. <b>Result</b> row 4 goes pending.",
          events: [
            { type: "next", result: "r3" },
          ],
        },
        {
          caption: "<code>flatMap</code> pulls the second inner iterator again — pending.",
          events: [
            { type: "inner-pull", pull: "b1", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The second inner iterator is also exhausted. <code>flatMap</code> advances to the next source value, forwarding another pull to <b>Underlying</b>.",
          events: [
            { type: "settle", pull: "b1", done: true },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The source itself is now exhausted — <code>{ done: true }</code>. With no inner iterators left to walk, that completion passes through: the fourth <code>.next()</code> resolves with <code>{ done: true }</code>, and both iterators are <b>closed</b> — marked with 🪦 beside their column headers.",
          events: [
            { type: "settle", pull: "u2", done: true },
            { type: "result", result: "r3", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
        {
          caption: "All the values from both inner iterators have been flattened into one stream, in order — <code>a1</code>, <code>a2</code>, <code>b1</code> — followed by <code>{ done: true }</code>. The run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-concurrent",
    helper: "flatMap",
    label: "Concurrent",
    description: "Concurrency on the <b>Result</b> side: the consumer issues a second <code>.next()</code> before the first has resolved. <code>flatMap</code> can’t pull ahead from the <b>Underlying</b> source — it must walk the current inner iterator to exhaustion before touching the next source value, and it doesn’t even <i>have</i> an inner iterator yet — so the second pull just waits. But once <code>f(A)</code> hands back its inner iterator, both outstanding pulls drive it at once: <code>flatMap</code> issues <i>two</i> concurrent inner pulls, yielding <code>a1</code> and <code>a2</code>. Source is <code>[A]</code>, <code>f(A)</code> yields <code>[a1, a2]</code>, so the flattened result is <code>a1, a2</code> then <code>{ done: true }</code>.",
    ticks: [
      { steps: [
        {
          caption: "Idle. This time the consumer is <b>concurrent</b>: it may call <code>.next()</code> again before the previous call has resolved. We’ll see what <code>flatMap</code> can and can’t parallelize.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. Pending on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Before that resolves, the consumer calls <code>.next()</code> <i>again</i> — row 2 goes pending. But <code>flatMap</code> can’t pull ahead from the source: it must exhaust the current inner iterator before advancing, and it doesn’t have one yet. So <b>no second Underlying pull</b> goes out — this <code>.next()</code> simply waits.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to an <i>inner async iterator</i>. Its box is <b>replaced</b> by that iterator, drawn as its own little run of pulls.",
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "Now there are <b>two</b> outstanding <code>.next()</code> calls and an inner iterator to serve them — so <code>flatMap</code> pulls it <i>twice, concurrently</i>. Both inner pulls go pending at once.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The inner iterator yields <code>a1</code>, forwarded to <b>Result</b>: the first <code>.next()</code> resolves with <code>{ value: a1 }</code>.",
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "It yields <code>a2</code> as well, resolving the second <code>.next()</code> with <code>{ value: a2 }</code>.",
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Consumer pulls a third time. <b>Result</b> row 3 goes pending.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "<code>flatMap</code> pulls the inner iterator once more — pending.",
          events: [
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The inner iterator is <b>exhausted</b> (<code>{ done: true }</code>). That <code>done</code> isn’t forwarded — instead <code>flatMap</code> advances to the next source value, forwarding a fresh pull to <b>Underlying</b>. The third <code>.next()</code> is still pending.",
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The source itself is now exhausted — <code>{ done: true }</code>. With no inner iterators left to walk, that completion passes through: the third <code>.next()</code> resolves with <code>{ done: true }</code>, and both iterators are <b>closed</b> — marked with 🪦 beside their column headers.",
          events: [
            { type: "settle", pull: "u1", done: true },
            { type: "result", result: "r2", done: true },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
          ],
        },
        {
          caption: "Concurrency on the consumer side let <code>a1</code> and <code>a2</code> be pulled from the inner iterator in parallel, but <code>flatMap</code> never raced ahead of the source — it pulled <code>Underlying</code> only once per source value. The flattened result is <code>a1</code>, <code>a2</code>, then <code>{ done: true }</code>.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-concurrent-2",
    helper: "flatMap",
    label: "Concurrent 2",
    description: "Three concurrent <code>.next()</code> calls, and the first inner iterator runs dry mid-batch. The consumer pulls <b>Result</b> three times up front; once <code>f(A)</code>’s inner iterator appears, all three drive it at once. But that iterator only has two values — its <i>third</i> pull comes back <code>{ done: true }</code>, so <code>flatMap</code> advances to source value <code>B</code>, maps it, and pulls its inner iterator to get a value for the still-outstanding third result. Delivery stays in source order: <code>b1</code> is held until <code>a1</code> and <code>a2</code> have gone out. Source <code>[A, B]</code>, <code>f(A)</code> yields <code>[a1, a2]</code>, <code>f(B)</code> yields <code>[b1, …]</code> — flattened result <code>a1, a2, b1</code>.",
    ticks: [
      { steps: [
        {
          caption: "Idle. This concurrent consumer will fire three <code>.next()</code> calls before any of them resolve.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. Pending on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting, the consumer calls <code>.next()</code> <i>again</i> — row 2 goes pending. It can’t pull ahead from the source (the current inner iterator must be exhausted first, and there isn’t one yet), so <b>no new Underlying pull</b> goes out.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "And a <i>third</i> <code>.next()</code> — row 3 goes pending too. Still no new Underlying pull: three results are now outstanding against a single source pull.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to an <i>inner async iterator</i>; its box is <b>replaced</b> by that iterator’s run of pulls.",
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "Three outstanding <code>.next()</code> calls, so <code>flatMap</code> pulls the inner iterator <i>three times, concurrently</i>. All three inner pulls go pending at once.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>third</i> inner pull settles first — with <code>{ done: true }</code>. The inner iterator is <b>exhausted</b>: it only had two values. That <code>done</code> isn’t forwarded; instead <code>flatMap</code> advances to the next source value, pulling <b>Underlying</b> again. The first two inner pulls are still in flight.",
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>B</code>; the mapper <code>f(B)</code> runs in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> resolves to a second inner iterator, which replaces its mapper box.",
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          caption: "The third result is still outstanding, so <code>flatMap</code> pulls the new inner iterator — pending.",
          events: [
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "It yields <code>b1</code>. But this <i>can’t</i> be delivered yet: the third <code>.next()</code> must resolve in source order, and <code>a1</code> and <code>a2</code> haven’t gone out. <code>b1</code> waits, <b>buffered</b>.",
          events: [
            { type: "settle", pull: "b0", value: "b1" },
          ],
        },
        {
          caption: "Now the first inner pull settles with <code>a1</code> — first in source order, so it’s forwarded straight to the first <code>.next()</code>: <code>{ value: a1 }</code>.",
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The second inner pull settles with <code>a2</code>, resolving the second <code>.next()</code> — and with row 2 now satisfied, the buffered <code>b1</code> is finally free to go: in the <i>same</i> step it’s forwarded to the third <code>.next()</code>. Two results settle at once, still in source order — <code>{ value: a2 }</code> then <code>{ value: b1 }</code>.",
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
            { type: "result", result: "r2", value: "b1", from: "b0" },
          ],
        },
        {
          caption: "All three results are delivered in source order — <code>a1</code>, <code>a2</code>, <code>b1</code> — spanning two source values. The second inner iterator still has more to give, waiting for the next pull.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-concurrent-2-prime",
    helper: "flatMap",
    label: "Concurrent 2′",
    description: "A variant of <b>Concurrent 2</b>, identical until the second inner pull settles — but this time the first inner iterator yields only <code>a1</code> and then runs dry, so its <i>second</i> pull also comes back <code>{ done: true }</code>. With <code>a2</code> never arriving, the buffered <code>b1</code> slides up to fill the <i>second</i> result, and <code>flatMap</code> pulls the second inner iterator once more to get <code>b2</code> for the third. Source <code>[A, B]</code>, <code>f(A)</code> yields <code>[a1]</code>, <code>f(B)</code> yields <code>[b1, b2, …]</code> — flattened result <code>a1, b1, b2</code>.",
    ticks: [
      { steps: [
        {
          caption: "Idle. This concurrent consumer will fire three <code>.next()</code> calls before any of them resolve.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. Pending on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting, the consumer calls <code>.next()</code> <i>again</i> — row 2 goes pending. It can’t pull ahead from the source (the current inner iterator must be exhausted first, and there isn’t one yet), so <b>no new Underlying pull</b> goes out.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "And a <i>third</i> <code>.next()</code> — row 3 goes pending too. Still no new Underlying pull: three results are now outstanding against a single source pull.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to an <i>inner async iterator</i>; its box is <b>replaced</b> by that iterator’s run of pulls.",
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "Three outstanding <code>.next()</code> calls, so <code>flatMap</code> pulls the inner iterator <i>three times, concurrently</i>. All three inner pulls go pending at once.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>third</i> inner pull settles first — with <code>{ done: true }</code>. The inner iterator is <b>exhausted</b>; that <code>done</code> isn’t forwarded. <code>flatMap</code> advances to the next source value, pulling <b>Underlying</b> again. The first two inner pulls are still in flight.",
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Underlying settles with <code>B</code>; the mapper <code>f(B)</code> runs in the second <b>Internal</b> row.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> resolves to a second inner iterator, which replaces its mapper box.",
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          caption: "The third result is still outstanding, so <code>flatMap</code> pulls the new inner iterator — pending.",
          events: [
            { type: "inner-pull", pull: "b0", iterator: "B" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "It yields <code>b1</code>. But this <i>can’t</i> be delivered yet: the third <code>.next()</code> must resolve in source order, and <code>a1</code> and <code>a2</code> haven’t gone out. <code>b1</code> waits, <b>buffered</b>.",
          events: [
            { type: "settle", pull: "b0", value: "b1" },
          ],
        },
        {
          caption: "Now the first inner pull settles with <code>a1</code> — first in source order, so it’s forwarded straight to the first <code>.next()</code>: <code>{ value: a1 }</code>.",
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "But the second inner pull settles with <code>{ done: true }</code> too — the first iterator had only <i>one</i> value, so <code>a2</code> never comes. The next value in source order is the buffered <code>b1</code>, and with the first <code>.next()</code> already satisfied it now fills the <i>second</i> — <code>{ value: b1 }</code>. The third result is still outstanding, so (same step) <code>flatMap</code> pulls the second inner iterator again.",
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "inner-pull", pull: "b1", iterator: "B" },
            { type: "result", result: "r1", value: "b1", from: "b0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The second inner iterator yields <code>b2</code>, resolving the third <code>.next()</code> — <code>{ value: b2 }</code>.",
          events: [
            { type: "settle", pull: "b1", value: "b2" },
            { type: "result", result: "r2", value: "b2", from: "b1" },
          ],
        },
        {
          caption: "All three results are delivered in source order — <code>a1</code>, <code>b1</code>, <code>b2</code>. The first source value contributed only <code>a1</code> before its iterator ran dry; the rest came from <code>B</code>’s, which still has more to give.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-exhaustion",
    helper: "flatMap",
    label: "Exhaustion",
    description: "What happens when the <i>source</i> runs out mid-batch. As in <b>Concurrent 2</b>, three concurrent <code>.next()</code> calls drive one inner iterator and its third pull comes back <code>{ done: true }</code>, so <code>flatMap</code> reaches for the next source value — but the <b>Underlying</b> source is now exhausted too. There’s no next inner iterator, so the value the third result was waiting on never comes: it resolves with <code>{ done: true }</code> immediately, even though the first iterator’s two values <code>a1</code>, <code>a2</code> are still in flight and land in the first two results afterwards. Source <code>[A]</code>, <code>f(A)</code> yields <code>[a1, a2]</code> — flattened result <code>a1, a2</code>, then <code>{ done: true }</code>.",
    ticks: [
      { steps: [
        {
          caption: "Idle. This concurrent consumer will fire three <code>.next()</code> calls before any of them resolve.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. Pending on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Without waiting, the consumer calls <code>.next()</code> <i>again</i> — row 2 goes pending. It can’t pull ahead from the source (the current inner iterator must be exhausted first, and there isn’t one yet), so <b>no new Underlying pull</b> goes out.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "And a <i>third</i> <code>.next()</code> — row 3 goes pending too. Still no new Underlying pull: three results are now outstanding against a single source pull.",
          events: [
            { type: "next", result: "r2" },
          ],
        },
        {
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to an <i>inner async iterator</i>; its box is <b>replaced</b> by that iterator’s run of pulls.",
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "Three outstanding <code>.next()</code> calls, so <code>flatMap</code> pulls the inner iterator <i>three times, concurrently</i>. All three inner pulls go pending at once.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
            { type: "inner-pull", pull: "a2", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>third</i> inner pull settles first — with <code>{ done: true }</code>. The inner iterator is <b>exhausted</b>; that <code>done</code> isn’t forwarded. <code>flatMap</code> advances to the next source value, pulling <b>Underlying</b> again. The first two inner pulls are still in flight.",
          events: [
            { type: "settle", pull: "a2", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "But the <b>source</b> is exhausted too — that second Underlying pull settles with <code>{ done: true }</code>. There’s no next inner iterator to walk, so the value the third <code>.next()</code> was waiting on never comes: it resolves with <code>{ done: true }</code>, and both iterators are <b>closed</b> — 🪦. (The first two inner pulls are still in flight; they’ll still deliver <code>a1</code> and <code>a2</code> to the first two results.)",
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
          caption: "Now the first inner pull settles with <code>a1</code>, forwarded to the first <code>.next()</code> — <code>{ value: a1 }</code>.",
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "And the second settles with <code>a2</code>, forwarded to the second <code>.next()</code> — <code>{ value: a2 }</code>.",
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
        {
          caption: "All three results are delivered in source order — <code>a1</code>, <code>a2</code>, then <code>{ done: true }</code>. Note the <code>done</code> reached the third result <i>before</i> its two predecessors settled: result promises resolve independently in time, but each carries the value for its slot in source order.",
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
          caption: "Idle. This time the consumer is <b>concurrent</b>: it may call <code>.next()</code> again before the previous call has resolved. We’ll see what <code>flatMap</code> can and can’t parallelize.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. Pending on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Before that resolves, the consumer calls <code>.next()</code> <i>again</i> — row 2 goes pending. But <code>flatMap</code> can’t pull ahead from the source: it must exhaust the current inner iterator before advancing, and it doesn’t have one yet. So <b>no second Underlying pull</b> goes out — this <code>.next()</code> simply waits.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to an <i>inner async iterator</i>. Its box is <b>replaced</b> by that iterator, drawn as its own little run of pulls.",
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "Now there are <b>two</b> outstanding <code>.next()</code> calls and an inner iterator to serve them — so <code>flatMap</code> pulls it <i>twice, concurrently</i>. Both inner pulls go pending at once.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The inner iterator yields <code>a1</code>, forwarded to <b>Result</b>: the first <code>.next()</code> resolves with <code>{ value: a1 }</code>.",
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
        {
          caption: "The consumer calls <code>.return()</code> on the <b>Result</b> iterator — it wants to stop early. The diagram shifts down and the teardown band slides in above: <code>flatMap</code> must close the source, the current inner iterator, and the result.",
          events: [
            { type: "open-closing" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "To honour the <code>.return()</code>, <code>flatMap</code> begins tearing down. The <code>result.return()</code> call is now in flight — pending.",
          events: [
            { type: "return", result: "ret" },
          ],
        },
        {
          caption: "Both the source and the result are being closed, so the <b>Underlying</b> and <b>Result</b> columns get their tombstones — 🪦. The inner iterator that’s still mid-flight must be closed too: <code>inner.return()</code> goes pending.",
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
            { type: "close", target: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>inner.return()</code> settles with <code>{}</code> — the inner iterator is closed. Now <code>flatMap</code> closes the source: <code>underlying.return()</code> goes pending.",
          events: [
            { type: "close-settled", target: "A" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>underlying.return()</code> settles with <code>{}</code> — the source is closed — and <code>result.return()</code> settles with <code>{}</code> as well. The teardown is complete.",
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Only now does the second inner pull settle — it yields <code>a2</code>, which still goes to the outstanding second <code>.next()</code>: <b>Result</b> row 2 resolves with <code>{ value: a2 }</code>.",
          events: [
            { type: "settle", pull: "a1", value: "a2" },
            { type: "result", result: "r1", value: "a2", from: "a1" },
          ],
        },
        {
          caption: "Both outstanding <code>.next()</code> calls have delivered their values, and all three iterators are closed — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-closing-2",
    helper: "flatMap",
    label: "Closing 2",
    description: "We close only the active inner iterator, but values from earlier ones may still be delivered.",
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
    description: "When <code>result.return()</code> is called while we are blocked on pulling from the underlying iterator or on the mapper, we wait for that to settle and close the resulting iterator. Only once that completes does the <code>result.return()</code> Promise settle.<br><br>We hold open a Promise from <code>result.next()</code> in case the underlying pull or the mapper throws.",
    ticks: [
      { steps: [
        {
          caption: "Idle. This time the consumer is <b>concurrent</b>: it may call <code>.next()</code> again before the previous call has resolved. We’ll see what <code>flatMap</code> can and can’t parallelize.",
          events: [],
        },
        {
          caption: "Consumer calls <code>.next()</code> on the <b>Result</b> iterator. Pending on row 1.",
          events: [
            { type: "next", result: "r0" },
          ],
        },
        {
          caption: "Result forwards a pull to the <b>Underlying</b> source. Pending.",
          events: [
            { type: "pull", pull: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Before that resolves, the consumer calls <code>.next()</code> <i>again</i> — row 2 goes pending. But <code>flatMap</code> can’t pull ahead from the source: it must exhaust the current inner iterator before advancing, and it doesn’t have one yet. So <b>no second Underlying pull</b> goes out — this <code>.next()</code> simply waits.",
          events: [
            { type: "next", result: "r1" },
          ],
        },
        {
          caption: "Underlying settles with <code>A</code> and hands it to the <b>Internal</b> stage, which invokes the mapper <code>f(A)</code> — pending while it runs.",
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p0", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(A)</code> resolves to an <i>inner async iterator</i>. Its box is <b>replaced</b> by that iterator, drawn as its own little run of pulls.",
          events: [
            { type: "fn-settle", call: "p0", iterator: "A" },
          ],
        },
        {
          caption: "Now there are <b>two</b> outstanding <code>.next()</code> calls and an inner iterator to serve them — so <code>flatMap</code> pulls it <i>twice, concurrently</i>. Both inner pulls go pending at once.",
          events: [
            { type: "inner-pull", pull: "a0", iterator: "A" },
            { type: "inner-pull", pull: "a1", iterator: "A" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "Meanwhile the first inner pull settles — it yields <code>a1</code>, forwarded to the first <code>.next()</code>: <b>Result</b> row 1 resolves with <code>{ value: a1 }</code>.",
          events: [
            { type: "settle", pull: "a0", value: "a1" },
            { type: "result", result: "r0", value: "a1", from: "a0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "The <i>second</i> inner pull settles first — with <code>{ done: true }</code>. The inner iterator had only one value, so it’s <b>exhausted</b>. That <code>done</code> isn’t forwarded; instead <code>flatMap</code> advances to the next source value, forwarding a fresh pull to <b>Underlying</b>. (The first inner pull is still in flight.)",
          events: [
            { type: "settle", pull: "a1", done: true },
            { type: "pull", pull: "u1" },
          ],
        },
        {
          caption: "Now the consumer calls <code>.return()</code> on the <b>Result</b> iterator — it wants to stop early. The diagram shifts down and the teardown band slides in above.",
          events: [
            { type: "open-closing" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "To honour the <code>.return()</code>, <code>flatMap</code> begins tearing down. The <code>result.return()</code> call is now in flight — pending.",
          events: [
            { type: "return", result: "ret" },
          ],
        },
        {
          caption: "Both the source and the result are being closed, so the <b>Underlying</b> and <b>Result</b> columns get their tombstones — 🪦. There’s no live inner iterator to close — the last one already finished — so <code>flatMap</code> goes straight to the source: <code>underlying.return()</code> goes pending.",
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>underlying.return()</code> settles with <code>{}</code> — the source is closed. <code>result.return()</code> is still in flight: it won’t settle until the inner iterator <code>flatMap</code> is about to acquire has been closed too.",
          events: [
            { type: "close-settled", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "And the second <b>Underlying</b> pull — the one <code>flatMap</code> fired when the inner ran dry — resolves with <code>B</code>, handed to the <b>Internal</b> stage where the mapper <code>f(B)</code> runs, pending.",
          events: [
            { type: "settle", pull: "u1", value: "B" },
            { type: "fn", call: "p1", arg: "B", from: "u1" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>f(B)</code> resolves to a second inner iterator, which replaces its mapper box — had <code>f(B)</code> thrown instead, this is where that error would surface. But the result has already been returned, so <code>flatMap</code> never pulls this iterator.",
          events: [
            { type: "fn-settle", call: "p1", iterator: "B" },
          ],
        },
        {
          caption: "It must be closed instead: <code>inner.return()</code> goes pending.",
          events: [
            { type: "close", target: "B" },
          ],
        },
        {
          caption: "With its iterator being discarded unpulled, the still-outstanding second <code>.next()</code> resolves with <code>{ done: true }</code> — it does <i>not</i> wait for the inner close to settle.",
          events: [
            { type: "result", result: "r1", done: true },
          ],
        },
      ] },
      { steps: [
        {
          caption: "<code>inner.return()</code> settles with <code>{}</code> — the inner iterator is closed — and only now does <code>result.return()</code> settle with <code>{}</code> as well.",
          events: [
            { type: "close-settled", target: "B" },
            { type: "result", result: "ret", done: true },
          ],
        },
        {
          caption: "The first <code>.next()</code> delivered <code>a1</code>; the second resolved with <code>{ done: true }</code> when the result was returned. All the iterators are closed — the run is complete.",
          events: [],
        },
      ] },
    ],
  },
  {
    id: "flatmap-during-pull-2",
    helper: "flatMap",
    label: "Closing during pull 2",
    description: "Same scenario as \"Closing during pull\", except we have an extra pull. It resolves as soon as <code>result.return()</code> is invoked.",
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
            { type: "close", target: "source" },
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
            { type: "result", result: "ret", done: true },
          ],
        },
      ] },
    ],
  },
  {
    id: "flatmap-error-in-underlying-during-return",
    helper: "flatMap",
    label: "Error in underlying during return",
    description: "Same scenario as <a href=\"#flatmap-closing-during-pull\">Closing during pull</a>, except now the underlying pull throws.",
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
            { type: "close", target: "source" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
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
    id: "flatmap-error-in-active-iterator",
    helper: "flatMap",
    label: "Error in active inner",
    description: "An error in the active inner iterator the underlying iterator. The result Promise where the error will ultimately land is held until closing finishes.",
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
    description: "An error in a no-longer-active inner iterator closes both the active inner iterator and the underlying iterator (concurrently).",
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
            { type: "open-closing" },
          ],
        },
        {
          events: [
            { type: "settle", pull: "a0", error: "boom" },
          ],
        },
        {
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

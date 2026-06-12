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
    description: "Arrows or buttons at the bottom to navigate, alt-arrow to switch to other animations, click the names of the other helpers at the top for theirs. Dots indicate where some external-to-the-machinery action is about to occur.<br><br>This is a baseline for <code>.filter</code> with no concurrency. It works like you'd expect.",
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
            { type: "fn-settle", call: "p0", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p0" },
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
            { type: "fn-settle", call: "p1", verdict: false },
          ],
        },
        {
          caption: "When a predicate resolves to <code>false</code>, the machinery discards its internal slot and issues a new pull from the underlying iterator.",
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
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
            { type: "fn-settle", call: "p2", verdict: true },
            { type: "result", result: "r1", value: "C", from: "p2" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-concurrent",
    helper: "filter",
    label: "Simple concurrent",
    description: "As with <code>map</code>, multiple pulls can be in flight. Unlike <code>map</code>, later values cannot generally settle until earlier ones have resolved, because resolution of earlier predicates affects where later values will end up.",
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
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          events: [
            { type: "compact", pull: "u1" },
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
          caption: "The value can't be delivered until the earlier items are processed.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p2", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "When the head of the queue settles we can drain items behind it.",
          events: [
            { type: "fn-settle", call: "p2", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p2" },
            { type: "result", result: "r1", value: "C", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-concurrent-2",
    helper: "filter",
    label: "Simple concurrent 2",
    description: "Values can also reach the head of the queue as a consequence of earlier values failing to pass the predicate. This is identical to the previous run except that the first value fails the predicate.",
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
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          events: [
            { type: "compact", pull: "u1" },
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
            { type: "fn-settle", call: "p1", verdict: true },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p2", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p2", verdict: false },
          ],
        },
        {
          caption: "As before, we discard the value which failed the predicate and issue a new pull to replace it. But in this case discarding a value has caused another value (which passed the predicate) to reach the head of the queue, so it can be delivered.",
          events: [
            { type: "compact", pull: "u0" },
            { type: "pull", pull: "u3" },
            { type: "result", result: "r0", value: "C", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u3", value: "D" },
            { type: "fn", call: "p3", arg: "D", from: "u3" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p3", verdict: true },
            { type: "result", result: "r1", value: "D", from: "p3" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-exhaustion",
    helper: "filter",
    label: "Exhaustion",
    description: "Values are now shown as full iterator records (<code>done</code>/<code>value</code>). When the underlying iterator is finished, we can settle some number of result Promises that we now know cannot receive a value.",
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
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", done: true },
          ],
        },
        {
          caption: "Because we now know the underlying iterator (unless incoherent) cannot produce more than one value which passes the predicate, we can now settle the 2nd outstanding result Promise.",
          events: [
            { type: "result", result: "r1", done: true },
          ],
        },
        {
          caption: "This also tells us that the iterator is complete; we record this so that further results are not forwarded to it.",
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
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          caption: "As before, we can still deliver already-pulled values which arrive after close.",
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-exhaustion-2",
    helper: "filter",
    label: "Exhaustion 2",
    description: "As in <a href=\"#filter-exhaustion\">Exhaustion</a>, but now a predicate returns <code>false</code> after exhaustion. Because the iterator is closed, we do not pull again to replace the value which failed.",
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
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", done: true },
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
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", verdict: false },
          ],
        },
        {
          caption: "When the iterator was open we would have re-pulled when a value failed the predicate, but because the iterator is closed at this point we do not and instead settle the outstanding Promise with <code>done: true</code>.",
          events: [
            { type: "result", result: "r0", done: true },
          ],
        },
      ] },
    ],
  },
  {
    id: "filter-exhaustion-3",
    helper: "filter",
    label: "Exhaustion 3*",
    description: "As in <a href=\"#filter-exhaustion-2\">Exhaustion 2</a>, but with one more pull outstanding. In this case, an underlying Promise settles with <code>done: true</code> while a later one is still outstanding. Unlike <code>map</code>, if it ends up being a <code>done: false</code> value, there is no reasonable place to put it, so it is essentially <span style=\"color:#8b5cf6\">voided</span>.<br><br><strong>Open question</strong>: What happens to that purple Promise if it ends up being something other than <code>done: true</code>? <code>unhandledrejection</code>?",
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
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          events: [
            { type: "compact", pull: "u1" },
            { type: "pull", pull: "u2" },
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
            { type: "pull", pull: "u3" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", done: true },
          ],
        },
        {
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
          events: [
            { type: "settle", pull: "u0", value: "A" },
            { type: "fn", call: "p1", arg: "A", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-exhaustion-4",
    helper: "filter",
    label: "Exhaustion 4",
    description: "As in <a href=\"#filter-exhaustion-3\">Exhaustion 3</a>, but the value that is beyond the <code>done: true</code> position has already settled and passed the predicate. This has the same effect; it is still <span style=\"color:#8b5cf6\">voided</span>.",
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
            { type: "settle", pull: "u0", value: "B" },
            { type: "fn", call: "p0", arg: "B", from: "u0" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          events: [
            { type: "compact", pull: "u0" },
            { type: "pull", pull: "u1" },
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
            { type: "pull", pull: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "settle", pull: "u2", value: "D" },
            { type: "fn", call: "p1", arg: "D", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
          ],
        },
        {
          events: [
            { type: "settle", pull: "u1", done: true },
          ],
        },
        {
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
    description: "As with <a href=\"#map-closing\"><code>map</code></a>, calls to <code>.return()</code> can be made concurrently with calls to <code>.next()</code>. This blocks future pulls but previous ones can still deliver values if they pass the predicate.",
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
          events: [
            { type: "tombstone", target: "result" },
          ],
        },
        {
          events: [
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
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
          events: [
            { type: "fn-settle", call: "p0", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p0" },
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
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r1", value: "B", from: "p1" },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-closing-2",
    helper: "filter",
    label: "Closing 2*",
    description: "As in <a href=\"#filter-closing\">Closing</a>, but now a predicate returns false after we have called <code>.return()</code>. Because the iterator is closed at that point, we do not issue a pull to replace the missing value.<br><br><strong>Open question</strong>: does calling <code>.return()</code> on the result iterator indicate only that we will no longer request <em>new</em> values, or also that we don't care about outstanding pulls? If the former, we can't call <code>underlying.return()</code> until we know we won't need a new value from it.",
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
          events: [
            { type: "tombstone", target: "result" },
          ],
        },
        {
          events: [
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
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
          events: [
            { type: "fn-settle", call: "p0", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p0" },
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
            { type: "fn-settle", call: "p1", verdict: false },
          ],
        },
        {
          events: [
            { type: "compact", pull: "u1" },
            { type: "result", result: "r1", done: true },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-error-underlying",
    helper: "filter",
    label: "Error in underlying",
    description: "Unlike <a href=\"#map-error-underlying\"><code>map</code></a>, errors cannot be delivered eagerly and must be held in the queue.",
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
          arrows: [["U1","I1"]],
          events: [
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
            { type: "slot-error", pull: "u1" },
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
            { type: "fn-settle", call: "p0", verdict: false },
          ],
        },
        {
          arrows: [["I0","R0"]],
          events: [
            { type: "compact", pull: "u0" },
            { type: "result", result: "r0", error: "boom" },
            { type: "result", result: "r1", done: true },
          ],
        },
        {
          events: [],
        },
      ] },
    ],
  },
  {
    id: "filter-error-predicate",
    helper: "filter",
    label: "Error in predicate",
    description: "As in <a href=\"#filter-error-in-underlying\">Error in underlying</a>, but the error occurs in the predicate. In this case we close the underlying iterator.",
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
          events: [
            { type: "close-settled", target: "source" },
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
          arrows: [["I0","R0"],["I1","R1"]],
          events: [
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
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
    id: "filter-error-predicate-2",
    helper: "filter",
    label: "Error in predicate 2",
    description: "Errors that cause <code>.return()</code> to be called cannot be delivered until the call to <code>.return()</code> settles.",
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
            { type: "close", target: "source" },
            { type: "tombstone", target: "underlying" },
            { type: "tombstone", target: "result" },
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
            { type: "fn-settle", call: "p1", verdict: true },
            { type: "result", result: "r0", value: "A", from: "p1" },
          ],
        },
      ] },
      { steps: [
        {
          events: [
            { type: "close-settled", target: "source" },
            { type: "result", result: "r1", error: "boom" },
          ],
        },
      ] },
    ],
  },
  {
    id: "filter-error-predicate-3",
    helper: "filter",
    label: "Error in predicate 3",
    description: "Requests which were in flight when an error occurred can still be delivered and land after the error.",
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
            { type: "open-closing" },
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
          events: [
            { type: "settle", pull: "u2", value: "C" },
            { type: "fn", call: "p2", arg: "C", from: "u2" },
          ],
        },
      ] },
      { steps: [
        {
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

# `filter` for async iterators — behavioral specification

`filter(it, pred)` takes an async iterator `it` and a predicate `pred`, and
returns a new async iterator. Consuming the result yields the values of `it`
for which `pred` returns (or resolves to) a truthy value, dropping the rest.

`pred` is called with one value and may return a boolean or a promise of one;
it may also return synchronously, reject, or throw synchronously. The source's
`next()` may return a promise, resolve later, reject, or throw synchronously.

The result supports **concurrency**: several `next()` calls may be outstanding
at once, and each is allowed to drive work on the source without waiting for the
earlier calls to settle.

This document specifies the observable behavior: which calls the result makes to
`it.next()`, `it.return()`, and `pred`, and when each `next()`/`return()` promise
settles — independent of how it is implemented.

---

## 1. The pull model

While the result is **live** (no terminal event has occurred — see §5), each
`next()` call made by the consumer synchronously issues **exactly one**
`it.next()` pull. So *K* outstanding `next()` calls produce *K* concurrent pulls,
in call order. The first `next()` pulls immediately; it does not wait for a
previous pull to settle.

When a pull resolves with a value, `pred` is invoked on that value (once). When a
pull resolves with `{ done: true }` or rejects, `pred` is not invoked for it.

Think of the result as maintaining an ordered queue of **positions**, one per
in-flight pull, in pull order. A position is *pending* until its pull (and, for a
value, its predicate) settles. Each position eventually resolves to one of:

- a **kept value** — the pull yielded a value and `pred` passed it;
- a **drop** — the pull yielded a value but `pred` rejected it (resolved falsy);
- an **error** — the pull rejected, or `pred` threw / rejected on its value;
- a **done** — the pull yielded `{ done: true }`.

---

## 2. Delivery order — the central rule

Outstanding `next()` calls are served **strictly in call order** for kept values
and errors. Equivalently: the *i*-th position (in pull order) that resolves to a
kept value or an error is matched to the *i*-th `next()` call (in call order).

A consequence that distinguishes `filter` from `map`: **a later call generally
cannot settle with a value or an error before every earlier call has settled.** A
later position's value may become known first, but it cannot be handed out yet,
because if an earlier position turns out to be a drop this value belongs to the
earlier call instead. So nothing is delivered past a still-**pending** earlier
position — it is *pending-ness*, not mere earlier-ness, that blocks: an earlier
position whose outcome is already known (a value, or an error) cannot swallow a
later value, so it does not hold later delivery hostage in the same way.

Two cases let a later call settle ahead of an earlier one:

- **done** can settle a later call early (see §4).
- An earlier **error that is only waiting for its source close** to settle (a
  predicate error, see §6) does not block later calls. Its recipient is already
  fixed (a head error cannot be dropped onto an earlier call), so the later calls
  take their own values/done while that one call alone waits for the close.

Outside these, settlement is in call order.

---

## 3. Drops and replacement pulls

A drop (a value rejected by `pred`) is removed from the queue entirely and is
never delivered; the queue **compacts** around it. Because an outstanding call
still needs a value, the result — **if it is still live** — immediately issues a
**replacement** `it.next()` pull. The replacement does *not* occupy the dropped
position's slot: it is a fresh pull appended at the **back** of the queue (it is,
after all, the most recent pull), and its value is subject to `pred` like any
other.

Surviving values continue to fill the outstanding calls in call order, regardless
of which pull (original or replacement) produced them. A consequence of compaction
plus back-appending: an already-known value from a *later* pull is **not** held
behind a freshly-issued replacement. As soon as the positions ahead of it resolve
(or drop), it shifts forward to the earliest still-waiting call — exactly the
forward-shift §2 describes when an earlier position turns out to be a drop. The
replacement only ever serves a call that no surviving value reaches.

A drop on its own — while the result is still live — never settles any call as
done; another replacement pull could always still produce a value.

---

## 4. Exhaustion (`done`) and the value ceiling

A `{ done: true }` from the source is **terminal**: it ends the sequence at that
position and makes the result *finished* (§5). A clean done does **not** close the
source — `it.return()` is not called — and, **while the source is still open**, it
makes every *later* in-flight pull unobservable: positions after the done are
discarded, and a value arriving later for such a position is ignored without
invoking `pred`. (A done received *after* the source has been closed is not a wall;
see §6.)

Once the result is finished, no replacement pulls can ever happen, so the number
of values it can still deliver is fixed. Define, at any such moment:

- **R** = outstanding `next()` calls not yet settled, and
- **V** = the **value ceiling**: the number of still-live, not-yet-delivered
  positions (pending, kept-value, or error positions — everything before the
  terminal wall).

If **R > V**, the surplus calls — the **most recently made** ones — settle
`{ done: true }` immediately, even while earlier calls remain pending on their own
positions. The first *V* calls stay outstanding, to be served in order by the
live positions.

This is the only mechanism by which a later call settles before an earlier one,
and it fires as a single step: one terminal event releases *all* the trailing
calls that exceed the ceiling at once, not one per event. When several are
released together, they settle in **call order** (the earliest of the released
trailing calls first), even though it is the most-recently-made calls being
retired.

While the result is still **live**, the ceiling is not used to settle anyone done:
a replacement pull can always raise it again. The ceiling only governs behavior
once the result is finished.

Each subsequent drop of a still-live earlier position (after the result is
finished) lowers V by one, releasing one more trailing call to done. The drop
retires the *latest* still-pending call; earlier calls keep waiting for their own
in-flight positions, which may still deliver real values.

After a clean done has settled every outstanding call, later settlements of pulls
or predicates that were already in flight have no observable effect.

---

## 5. Terminal events and the finished state

The result becomes **finished** on the first of: a source `done`, a source error
(pull rejection), a predicate error (throw or rejection), or a `return()` call.
Once finished:

- no further `it.next()` pulls are issued (no replacements);
- any `next()` call made afterward returns `{ done: true }` without pulling;
- the value ceiling of §4 governs the outstanding calls.

Note that becoming finished does **not** by itself reject or drop the
already-outstanding calls; they continue to be served by the pulls already in
flight (§6, §7).

---

## 6. Errors

An error — whether from the source pull rejecting or from `pred` throwing /
rejecting — is **positional**, exactly like a kept value: it occupies the position
of the pull it came from (for a source error) or of the value it was evaluated on
(for a predicate error). It finishes the result (§5), but:

- It rejects **exactly one** call — the one that lands on that position in call
  order. It does not reject unrelated outstanding calls.
- Earlier positions are unaffected: an earlier in-flight value still passes
  through `pred` and is delivered to its call first; only then does the error
  reach the call at its own position. **A value is never lost to a later error.**
- Later already-issued pulls are unaffected: a trailing call that already has its
  own pull in flight can still receive a real value — an error does **not** force
  already-vended calls to done.
- Because the result is now finished, drops cannot be replaced, so any trailing
  call that *would* need a new pull (its position drops) settles `{ done: true }`
  rather than hang. Trailing calls beyond the value ceiling (§4) settle done.

**Ordering with drops.** Like any position, an error waits its turn at the head of
the queue: while an earlier position is still pending, the error cannot surface.
If that earlier position then drops, the error **compacts forward** to reject the
now-earliest waiting call — an earlier drop can shift an error onto an earlier
call. A source error, which involves no close, is then observed *before* any
trailing done that the same drop step produces. A predicate error is additionally
gated on its source close (below): the trailing done does not wait on the close,
so if that `it.return()` has not yet settled the done is observed *first*, and the
error follows once the close settles.

**Closing the source.** A predicate error closes the source via `it.return()`.
Closing is part of finishing, so the rejection is **withheld until that
`it.return()` result settles** — only then is the error surfaced to its call.
(The close result itself, a value or a rejection, is discarded; it matters only as
the signal that closing is complete. A missing `it.return()`, or one that throws or
returns a non-thenable, settles synchronously, so the error is surfaced with no
delay.) **Only that one call waits.** Once the error reaches the head of the queue
its recipient is fixed (a head error cannot be dropped onto an earlier call), so
everything else proceeds without the close: earlier positions deliver their values,
the values *behind* the error are delivered to the later calls, and trailing calls
beyond the value ceiling (§4) settle `done` — none of them gated on the close.

A source error does **not** call `it.return()` — the source already faulted, and
the result never calls `it.return()` after observing a source error — so a source
error is surfaced with no such delay.

**A done overrides a later error — but only while the source is open.** A done
received while the source is still open discards every later position, including one
that already errored (e.g. a pull that threw synchronously before the done arrived):
that speculative over-pull is beyond the sequence's end, so its error is suppressed,
not resurrected, even if an earlier value is later dropped. This still holds after a
*source error* finishes the result, because a source error does **not** close the
source: a subsequent source done is a genuine wall.

**A done from a closed source is not a wall.** Once we have closed the source via
`it.return()` — that is, after a predicate error (§6) or a `return()` (§7) — a
`{ done: true }` it then produces is just the source draining the close, not a new
terminal event. It must not retroactively discard an already-determined later
position, which would silently **swallow** that outcome (the confusing case where a
source reacts to `it.return()` by resolving an earlier outstanding pull with done,
erasing the very predicate error that triggered the close). So such a done empties
only its own slot, like a drop: a later kept value or error still **compacts
forward** to the earliest waiting call, and the trailing calls drain to done.

---

## 7. `return()`

`return()` finishes the result and resolves with `{ done: true }`.

- If the source is still live, `return()` closes it via `it.return()` **exactly
  once** before resolving.
- If the result was already finished (source already done or errored, or a prior
  `return()`), `return()` does **not** call `it.return()` again; it simply
  resolves `{ done: true }`.

`return()` means "no more demand," **not** "cancel the work already requested."
Calls that were already outstanding keep their in-flight pulls:

- An already-requested value that passes `pred` is still delivered to its call, in
  call order.
- Because the result is finished, a drop cannot be replaced, so an outstanding
  call whose position drops settles `{ done: true }` instead of hanging. As in §4,
  a drop retires the *latest* still-pending call, while an earlier call can still
  be satisfied by a later surviving in-flight value.

A `next()` call made after `return()` returns `{ done: true }`.

---

## 8. Summary of invariants

1. One `next()` ⇒ one source pull, while live; concurrent calls ⇒ concurrent
   pulls, in call order.
2. Each surviving outcome is matched to a call in order: the *i*-th surviving
   outcome (value or error) goes to the *i*-th call. Calls settle in call order
   apart from the two cases in (4).
3. A drop is invisible to consumers and, while live, triggers a replacement pull.
4. A later call can settle before an earlier one in exactly two cases, both only
   once the result is finished: a `done` past the value ceiling (§4), or an earlier
   error that is merely awaiting its source close (§6). A value never overtakes an
   earlier *pending* position.
5. An error rejects only the single call at its position; values are never lost to
   it, and it never forces an already-vended call to done.
6. A terminal event (done, source error, predicate error, `return()`) finishes the
   result: no more pulls, later `next()` calls are done, and no outstanding call is
   ever left permanently unsettled.
7. The source is closed via `it.return()` exactly once, and only by `return()` or
   a predicate error, and only while the source is still live — never after a
   source done or a source error. A predicate error's rejection is surfaced only
   after the `it.return()` it triggers has settled.
8. A `done` is a terminal wall (discarding later positions) only while the source is
   open. A `done` the source produces after we have closed it is not a wall, so an
   already-determined value or error is never silently swallowed by it (§4, §6).

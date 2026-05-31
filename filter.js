// filter(it, pred) — see filter-spec.md
//
// Returns a new async iterator (a FilterHelper) that yields the values of the
// async iterator `it` for which the (possibly async) predicate `pred` returns a
// truthy value, dropping the rest. The result supports concurrent `next()`
// calls.
//
// Internal model (per the spec):
//
//   * `#positions` is a plain array used as a queue, one entry per in-flight
//     source pull, in pull order. Each entry is a record discriminated on
//     `status` (one of 'pending' | 'value' | 'error' | 'dropped' | 'removed';
//     see the #positions declaration for the full shape). Delivery happens
//     strictly at the head (index 0), in call order: a head `value` resolves the
//     front call, a head `error` rejects it, a pending head blocks everything
//     behind it.
//   * A drop is recorded as a TOMBSTONE (status 'dropped') rather than removed
//     in place; it lingers in the array until the head reaches it and is then
//     shifted away. While live, a drop also issues a fresh replacement pull at
//     the back of the queue.
//   * A source `done` received while the source is still open is the terminal
//     wall: its position and every later one are discarded by popping from the back
//     until the done record itself is popped. A `done` received after we have
//     closed the source (it.return()) is not a wall — it just empties its own slot,
//     like a drop, so it cannot swallow an already-determined later outcome.
//   * `#calls` is a plain array used as a FIFO of outstanding consumer `next()`
//     calls, in call order; each entry is `{ resolve, reject }`.
//   * `#liveCount` is the number of still-deliverable positions (pending / value
//     / error — neither tombstoned nor discarded). It is the "value ceiling" V:
//     once finished, whenever there are more outstanding calls than that, the
//     trailing (most-recently made) surplus calls are released to `{done:true}`.
//     The raw array length is not the ceiling because it still includes
//     not-yet-skipped tombstones, so V is tracked as a counter instead.
//
// The collections are only ever as large as the concurrency window (the number
// of simultaneously-outstanding `next()` calls), so plain-array push/shift/pop
// are the right primitives — no auxiliary list structure is needed.

class FilterHelper {
  // The source async iterator and the predicate.
  #it;
  #pred;

  // Positions in pull order (see the model comment above). Each entry is one of:
  //
  //   type Position =
  //     | { status: 'pending' }
  //     | { status: 'value';   value: unknown }
  //     | { status: 'dropped' }
  //     | { status: 'error';   error: unknown; closeState: CloseState }
  //     | { status: 'removed' }
  //
  // 'removed' is the terminal state of a position discarded by a terminal `done`
  // wall: it is popped from the queue, and a later in-flight pull/predicate
  // settlement for it is ignored. For a predicate-error position, the it.return()
  // close must settle before the error is surfaced; `closeState` tracks that wait:
  //
  //   type CloseState =
  //     | 'ready'      // no wait: no close, or the close has already settled
  //     | 'awaiting'   // close pending, error not yet at the head of the queue
  //     | ((e: Error) => void) // close pending, error committed to its call — invoke to reject it
  //
  // See #predErrored.
  #positions = [];

  // Outstanding consumer next() calls in call order; each entry is
  // { resolve, reject }.
  #calls = [];

  // The value ceiling V: count of still-deliverable positions (pending / value /
  // error). Excludes tombstoned drops and discarded positions.
  #liveCount = 0;

  // Lifecycle. Two booleans, but only THREE of the four combinations are
  // reachable: #closed is only ever set on the same synchronous step that sets
  // #finished (see #closeSource), so a closed-but-not-finished state never exists.
  //
  //   #finished  #closed   state
  //   ---------  -------   -----------------------------------------------------
  //   false      false     live — source open, still pulling
  //   true       false     finished WITHOUT closing — source done or source error
  //   true       true      finished BY closing — return() or a predicate error
  //   false      true      (impossible)
  //
  // The open/closed distinction only matters after finishing: it tells a source
  // `done` whether it is a genuine terminal wall (open: caps speculative
  // over-pulls) or merely the source draining our it.return() (closed: empties
  // one slot like a drop, never a wall). See #handleDone.

  // True once a terminal event has occurred (source done, source error,
  // predicate error, or return()). No further source pulls are issued. While not
  // finished the source is necessarily live, and every terminal transition flips
  // this true in the same synchronous step.
  #finished = false;

  // True once we have closed the source via it.return() (a predicate error or a
  // return() call) — but NOT for a source done or source error, which finish
  // without closing.
  #closed = false;

  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

  // ---- source closing ---------------------------------------------------

  // Close the source via it.return(), returning the raw result (a value or
  // promise) so a caller can await it, or undefined if it.return is absent. May
  // throw synchronously. The "close exactly once, only while live" rule is
  // enforced by the callers: this only runs on the single live -> finished
  // transition (return() guards on #finished; a predicate error guards on
  // wasLive), so it is never reached after a source done/error or a prior close.
  #closeSource() {
    // We have entered the closing path; a source `done` from here on is just the
    // source draining the close, not a sequence-ending wall (see #handleDone).
    this.#closed = true;
    if (typeof this.#it.return !== 'function') return undefined;
    return this.#it.return();
  }

  // ---- pulling ----------------------------------------------------------

  // Issue one source pull, appended as a new position at the back of the queue.
  // A synchronous throw from it.next() is a source error at that position.
  #issuePull() {
    const pos = {
      status: 'pending',
      value: undefined,
      error: undefined,
      closeState: 'ready',
    };
    this.#positions.push(pos);
    this.#liveCount++;
    let result;
    try {
      result = this.#it.next();
    } catch (e) {
      // Synchronous throw: a source error at this position.
      pos.status = 'error';
      pos.error = e;
      this.#finished = true; // source faulted; never call it.return().
      this.#process();
      return;
    }

    // Resolve the pull one microtask hop later, handling the outcome in pull
    // order. A position discarded by a terminal `done` wall ('removed') is
    // ignored — its outcome no longer matters.
    Promise.resolve(result).then(
      (r) => {
        if (pos.status === 'removed') return;
        if (r && r.done) this.#handleDone(pos);
        else this.#invokePred(pos, r ? r.value : undefined);
      },
      (e) => {
        if (pos.status === 'removed') return;
        // Source error: a positional error that does NOT close the source.
        pos.status = 'error';
        pos.error = e;
        this.#finished = true; // never call it.return() after a source error.
        this.#process();
      }
    );
  }

  // ---- predicate --------------------------------------------------------

  #invokePred(pos, value) {
    pos.value = value;
    // The predicate is *called* synchronously (so the call is observed in pull
    // order), but its outcome is always handled one microtask hop later. A
    // synchronous throw is funneled through a rejected promise so it takes the
    // exact same deferred path as an asynchronous rejection — the source close
    // it triggers then lands after any delivery this same step unblocked.
    let res;
    try {
      res = this.#pred(value);
    } catch (e) {
      res = Promise.reject(e);
    }
    Promise.resolve(res).then(
      (keep) => {
        if (pos.status === 'removed') return;
        if (keep) {
          pos.status = 'value';
          this.#process();
        } else {
          this.#handleDrop(pos);
        }
      },
      (e) => this.#predErrored(pos, e)
    );
  }

  #predErrored(pos, err) {
    if (pos.status === 'removed') return; // discarded
    pos.status = 'error';
    pos.error = err;
    const wasLive = !this.#finished; // is this error the terminal event?
    this.#finished = true;
    if (wasLive) {
      // This error is the terminal event, so it closes the source. Its rejection
      // must wait for the it.return() to settle, so while that close is pending the
      // position is 'awaiting'. #process commits the error to its call by leaving a
      // rejector in closeState (without blocking the values behind it); the single
      // reaction below then either invokes that rejector or, if the error has not
      // reached the head yet, flips closeState to 'ready' so it rejects in order
      // once it does. A missing it.return(), a synchronous throw, or a non-thenable
      // result is already settled — closeState stays 'ready' and there is no delay.
      let r;
      try {
        r = this.#closeSource();
      } catch {
        // synchronous throw from it.return(): already settled, swallowed
      }
      if (r && typeof r.then === 'function') {
        pos.closeState = 'awaiting';
        const onClosed = () => {
          if (typeof pos.closeState === 'function') pos.closeState(err);
          else pos.closeState = 'ready';
        };
        r.then(onClosed, onClosed); // react once the close settles, swallowing it
      }
    }
    this.#process();
  }

  // ---- drops and done ---------------------------------------------------

  // Precondition: pos is not 'removed'. The sole caller (#invokePred's predicate
  // reaction) checks that and reaches here synchronously, so no re-check is needed.
  #handleDrop(pos) {
    // Tombstone the dropped position: it stays in #positions until the head
    // reaches it (then it is shifted away), but no longer counts toward the
    // value ceiling. Surviving values still deliver strictly in pull order, so
    // an already-known later value shifts forward to the earliest waiting call.
    pos.status = 'dropped';
    this.#liveCount--;
    if (!this.#finished) {
      // Still live: the outstanding call still needs a value, so issue a fresh
      // pull at the BACK of the queue. It does not take the dropped slot — its
      // value is just another candidate, behind everything already pulled.
      this.#issuePull();
    }
    // If finished, the position is simply gone; the value ceiling in #process()
    // will release a trailing call to done.
    this.#process();
  }

  // Precondition: pos is not 'removed'. The sole caller (#issuePull's pull
  // reaction) checks that and reaches here synchronously, so no re-check is needed.
  #handleDone(pos) {
    if (this.#closed) {
      // We already closed the source, so this done is not a sequence-ending wall —
      // it is just the source draining our it.return(). It must not discard an
      // already-determined later position (e.g. a value, or a predicate error that
      // triggered the close), which would silently swallow that outcome. Empty just
      // this one slot, like a drop (no replacement, since we are finished), so a
      // later value/error still compacts forward to its call.
      pos.status = 'dropped';
      this.#liveCount--;
      this.#process();
      return;
    }
    // The source is still open, so this done is the genuine terminal wall: discard
    // its position and every later one (overriding any later error or later done) —
    // those later positions are speculative over-pulls beyond the sequence's end.
    // Pop from the back until the done record itself is popped. `pos` is still
    // pending here (a pending head blocks delivery), so it has not been shifted off
    // the front and the pop-loop reaches it; earlier positions are left untouched.
    let discarded;
    do {
      discarded = this.#positions.pop();
      // Tombstoned drops were already counted out of #liveCount.
      if (discarded.status !== 'dropped') this.#liveCount--;
      discarded.status = 'removed';
    } while (discarded !== pos);
    this.#finished = true; // a clean done does not close the source.
    this.#process();
  }

  // ---- delivery ---------------------------------------------------------

  #process() {
    // 1) Compact leading tombstones (already out of #liveCount), so the head is
    //    a real outcome or a pending position.
    while (this.#positions.length > 0 && this.#positions[0].status === 'dropped') {
      this.#positions.shift();
    }

    // 2) Deliver from the head, in order. A pending head blocks everything
    //    behind it (its outcome could still be a drop, which would shift later
    //    values forward). A head error never blocks: even one still awaiting its
    //    source close is committed to the head call and deferred (below), letting
    //    the values behind it flow on.
    while (this.#calls.length > 0 && this.#positions.length > 0) {
      const pos = this.#positions[0];
      if (pos.status === 'value') {
        this.#positions.shift();
        this.#liveCount--;
        this.#calls.shift().resolve({ value: pos.value, done: false });
      } else if (pos.status === 'error') {
        this.#positions.shift();
        this.#liveCount--;
        const call = this.#calls.shift();
        if (pos.closeState === 'awaiting') {
          // The predicate-error close has not settled yet. Unlike a pending
          // position, a head error has a fixed recipient (it cannot be dropped onto
          // an earlier call), so commit it to this call by leaving a rejector for
          // the close reaction to invoke — without blocking the values behind it,
          // which keep flowing to the later calls below.
          pos.closeState = call.reject;
        } else {
          call.reject(pos.error); // 'ready': no close pending
        }
      } else if (pos.status === 'dropped') {
        this.#positions.shift(); // a tombstone exposed mid-loop
      } else {
        break; // pending
      }
    }

    // 3) Once finished, the value ceiling (#liveCount) releases the trailing
    //    (most-recently made) calls that exceed it to done. They are settled in
    //    call order, even though it is the latest calls being retired.
    if (this.#finished) {
      const surplus = this.#calls.length - this.#liveCount;
      if (surplus > 0) {
        const drained = [];
        for (let i = 0; i < surplus; i++) drained.push(this.#calls.pop());
        for (let i = drained.length - 1; i >= 0; i--) {
          drained[i].resolve({ value: undefined, done: true });
        }
      }
    }
  }

  // ---- consumer-facing iterator ----------------------------------------

  next() {
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    let resolve, reject;
    const p = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#calls.push({ resolve, reject });
    this.#issuePull(); // one pull per next().
    this.#process();
    return p;
  }

  return(value) {
    if (this.#finished) {
      return Promise.resolve({ value, done: true });
    }
    this.#finished = true;

    // Close the source before resolving. We were not yet finished (guarded
    // above), so the source is necessarily still live and this is the single
    // live -> finished transition that closes it. A synchronous throw from
    // it.return() rejects this return() call.
    let r;
    try {
      r = this.#closeSource();
    } catch (e) {
      this.#process();
      return Promise.reject(e);
    }

    // Outstanding calls keep their in-flight pulls; the ceiling governs them.
    this.#process();

    return Promise.resolve(r).then(() => ({ value, done: true }));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

export default function filter(it, pred) {
  return new FilterHelper(it, pred);
}

export { filter, FilterHelper };

// filter(it, pred) — see filter-spec.md
//
// Returns a new async iterator (a FilterHelper) that yields the values of the
// async iterator `it` for which the (possibly async) predicate `pred` returns a
// truthy value, dropping the rest. The result supports concurrent `next()`
// calls.
//
// Internal model (per the spec):
//
//   * `#positions` is a Set used as an ordered queue, one entry per in-flight
//     source pull, in pull order (= insertion order). Each entry is a record
//     discriminated on `status` (one of 'awaiting' | 'value' | 'error'; see the
//     #positions declaration for the full shape). Delivery happens strictly at
//     the head (the first-inserted entry), in call order: a head `value` resolves
//     the front call, a head `error` rejects it, an `awaiting` head blocks
//     everything behind it.
//   * A drop deletes its position from the Set immediately. While live, a drop
//     also issues a fresh replacement pull at the back of the queue.
//   * A source `done` is the terminal wall: its position and every later one are
//     deleted from the Set. This holds unconditionally — whether the source
//     finished on its own or is draining an it.return() we issued — so a `done`
//     always wins over every later position, even one that has already settled
//     with a value or an error.
//   * Because positions leave the Set only by being delivered, dropped, or
//     discarded, a pull/predicate settlement that arrives for a position no
//     longer in the Set is stale (it was discarded by a `done` wall) and is
//     ignored — that is the sole purpose of the #isIgnored membership check.
//   * `#calls` is a plain array used as a FIFO of outstanding consumer `next()`
//     calls, in call order; each entry is `{ resolve, reject }`.
//   * `#positions.size` is the "value ceiling" V: the count of still-deliverable
//     positions. Once finished, whenever there are more outstanding calls than
//     that, the trailing (most-recently made) surplus calls are released to
//     `{done:true}`.
//
// The collections are only ever as large as the concurrency window (the number
// of simultaneously-outstanding `next()` calls). A Set gives ordered iteration
// for head delivery together with O(1) deletion of an arbitrary dropped
// position, and membership doubles as the "not yet discarded" test.

class FilterHelper {
  // The source async iterator and the predicate.
  #it;
  #pred;

  // Positions in pull order (see the model comment above), held in a Set used as
  // an ordered queue: insertion order is pull order, so the head is the
  // first-inserted entry (`#head()`). Membership means "still live": a position
  // is in the Set from when its pull is issued until it is delivered, dropped, or
  // discarded by a terminal `done`. Each entry is one of:
  //
  //   type Position =
  //     | { status: 'awaiting' }
  //     | { status: 'value'; value: unknown }
  //     | { status: 'error'; error: unknown; closeState: CloseState }
  //
  // A dropped value, and a position discarded by a terminal `done` wall, are both
  // deleted from the Set; a pull/predicate settlement that later arrives for a
  // discarded position finds it absent (#isIgnored) and is dropped on the floor.
  // For a predicate-error position, the it.return() close must settle before the
  // error is surfaced; `closeState` tracks that wait:
  //
  //   type CloseState =
  //     | 'ready'      // no wait: no close, or the close has already settled
  //     | 'awaiting-return'   // close pending, error not yet at the head of the queue
  //     | ((e: Error) => void) // close pending, error committed to its call — invoke to reject it
  #positions = new Set();

  // Outstanding consumer next() calls in call order; each entry is
  // { resolve, reject }.
  #calls = [];

  // Lifecycle. A single boolean: true once a terminal event has occurred (source
  // done, source error, predicate error, or return()). No further source pulls are
  // issued. While not finished the source is necessarily live, and every terminal
  // transition flips this true in the same synchronous step.
  //
  // We do not track whether WE closed the source (via it.return()) versus the
  // source finishing on its own, because it makes no difference: a source `done`
  // is a terminal wall regardless, discarding every later position. The "close
  // exactly once, only while live" rule is enforced by the #finished guards on the
  // two closing callers (return() and the predicate-error path), not by a separate
  // closed flag.
  #finished = false;

  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

  // ---- pulling ----------------------------------------------------------

  // Issue one source pull, appended as a new position at the back of the queue.
  // A synchronous throw from it.next() is a source error at that position.
  #issuePull() {
    const pos = {
      status: 'awaiting',
      value: undefined,
      error: undefined,
      closeState: 'ready',
    };
    this.#positions.add(pos);
    let result;
    try {
      result = this.#it.next();
    } catch (e) {
      // Synchronous throw: a source error at this position. Like the async paths,
      // #issuePull only records the outcome; delivery is driven by the caller's
      // #processQueue() (in next() or the predicate-false case), so we do not process here.
      pos.status = 'error';
      pos.error = e;
      pos.closeState = 'ready'
      this.#finished = true; // source faulted; never call it.return().
      return;
    }

    Promise.resolve(result).then(
      (r) => {
        if (this.#isIgnored(pos)) return;
        // TODO handle errors from reading `done`/`value` properties
        if (r.done) {
          // A done is the terminal wall: discard its position and every later one
          // (overriding any later value, later error, or later done). While the source
          // was open those later positions are speculative over-pulls beyond the
          // sequence's end; once we have closed the source they are in-flight pulls the
          // close has now superseded. Either way the done wins. `pos` is still awaiting
          // here (an awaiting head blocks delivery), so it has not been delivered off the
          // front; iterate in insertion (= pull) order and, from `pos` onward, delete.
          // Earlier positions are left untouched.
          let discarding = false;
          for (const n of this.#positions) {
            if (n === pos) discarding = true;
            if (discarding) this.#positions.delete(n);
          }
          this.#finished = true; // a clean done does not close the source.
          this.#processQueue();
        } else {
          this.#invokePred(pos, r.value);
        }
      },
      (e) => {
        if (this.#isIgnored(pos)) return;
        // Source error: a positional error that does NOT close the source.
        pos.status = 'error';
        pos.error = e;
        pos.closeState = 'ready';
        this.#finished = true; // never call it.return() after a source error.
        this.#processQueue();
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
    // TODO reconsider: maybe we shouldn't have to pay a microtask tick if the
    // predicate synchronously returns true or false.
    let res;
    try {
      res = this.#pred(value);
    } catch (e) {
      res = Promise.reject(e);
    }
    Promise.resolve(res).then(
      (keep) => {
        if (this.#isIgnored(pos)) return;
        if (keep) {
          pos.status = 'value';
          this.#processQueue();
        } else {
          // A dropped value is deleted from the queue outright.
          this.#positions.delete(pos);
          if (!this.#finished) {
            this.#issuePull();
          }
          this.#processQueue();
        }
      },
      (err) => {
        if (this.#isIgnored(pos)) return;
        pos.status = 'error';
        pos.error = err;
        const wasLive = !this.#finished;
        this.#finished = true;
        if (wasLive) {
          // This error is the terminal event, so it closes the source. Its rejection
          // must wait for the it.return() to settle, so while that close is pending the
          // position is 'awaiting-return'. #processQueue commits the error to its call by leaving a
          // rejector in closeState (without blocking the values behind it); the single
          // reaction below then either invokes that rejector or, if the error has not
          // reached the head yet, flips closeState to 'ready' so it rejects in order
          // once it does. A missing it.return(), a synchronous throw, or a non-thenable
          // result is already settled — closeState stays 'ready' and there is no delay.
          let r;
          try {
            r = this.#it?.return();
          } catch {
            // synchronous throw from it.return() gets swallowed
          }
          if (r && typeof r.then === 'function') {
            pos.closeState = 'awaiting-return';
            const onClosed = () => {
              if (typeof pos.closeState === 'function') pos.closeState(err);
              else pos.closeState = 'ready';
            };
            r.then(onClosed, onClosed);
          } else {
            pos.closeState = 'ready';
          }
        }
        this.#processQueue();
      }
    );
  }

  // ---- delivery ---------------------------------------------------------

  #processQueue() {
    // 1) Deliver no-longer-awaiting values from the head, in order. Drops and
    //    discarded positions have already been deleted from #positions, so the
    //    head is always a real outcome or an awaiting position.
    while (this.#calls.length > 0 && this.#positions.size > 0) {
      const pos = this.#head();
      if (pos.status === 'value') {
        this.#positions.delete(pos);
        this.#calls.shift().resolve({ value: pos.value, done: false });
      } else if (pos.status === 'error') {
        this.#positions.delete(pos);
        const call = this.#calls.shift();
        if (pos.closeState === 'awaiting-return') {
          // This error triggered `#it.return()`, and the result has not yet settled.
          // Since this is the head of the queue, we can commit it to this call by leaving a rejector for
          // the close reaction to invoke, and can still drop `pos` from `#positions`.
          pos.closeState = call.reject;
        } else {
          // assert: pos.closeState === 'ready'
          call.reject(pos.error);
        }
      } else {
        // assert: pos.status === 'awaiting'
        break;
      }
    }

    // 2) Once finished, the value ceiling (#positions.size) releases the trailing
    //    (most-recently made) calls that exceed it to done. They are settled in
    //    call order, even though it is the latest calls being retired.
    if (this.#finished && this.#calls.length > this.#positions.size) {
      // Release the trailing (most-recently-made) surplus calls to done.
      const drained = this.#calls.splice(this.#positions.size);
      for (const call of drained) {
        call.resolve({ value: undefined, done: true });
      }
    }
  }

  // The head of the queue: the first-inserted (oldest) live position.
  #head() {
    return this.#positions.values().next().value;
  }

  // A settlement is stale if its position is no longer in the queue, which can
  // only mean a terminal `done` wall discarded it.
  #isIgnored(pos) {
    return !this.#positions.has(pos);
  }

  // ---- consumer-facing iterator ----------------------------------------

  next() {
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    const { resolve, reject, promise } = Promise.withResolvers();
    this.#calls.push({ resolve, reject });
    this.#issuePull(); // one pull per next().
    this.#processQueue();
    return promise;
  }

  return(value) {
    if (this.#finished) {
      // TODO do we await this value? do we do anything with it?
      return Promise.resolve({ value, done: true });
    }
    this.#finished = true;

    let r;
    try {
      r = this.#it?.return();
    } catch (e) {
      this.#processQueue();
      return Promise.reject(e);
    }

    // Outstanding calls keep their in-flight pulls; the ceiling governs them.
    this.#processQueue();

    return Promise.resolve(r).then(() => ({ value, done: true }));
  }
}

export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

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
//     source pull, in pull order. Each entry is a record `{ status, value,
//     error, removed }` with status one of 'pending' | 'value' | 'error' |
//     'dropped'. Delivery happens strictly at the head (index 0), in call order:
//     a head `value` resolves the front call, a head `error` rejects it, a
//     pending head blocks everything behind it.
//   * A drop is recorded as a TOMBSTONE (status 'dropped') rather than removed
//     in place; it lingers in the array until the head reaches it and is then
//     shifted away. While live, a drop also issues a fresh replacement pull at
//     the back of the queue.
//   * A source `done` is the terminal wall: its position and every later one are
//     discarded by popping from the back until the done record itself is popped.
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

  // Positions in pull order (see the model comment above). Each entry is a
  // record { status, value, error, removed, heldForClose }. `heldForClose` is
  // set on a predicate-error position whose rejection must wait for the
  // it.return() it triggered to settle (see #predErrored).
  #positions = [];

  // Outstanding consumer next() calls in call order; each entry is
  // { resolve, reject }.
  #calls = [];

  // The value ceiling V: count of still-deliverable positions (pending / value /
  // error). Excludes tombstoned drops and discarded positions.
  #liveCount = 0;

  // True once a terminal event has occurred (source done, source error,
  // predicate error, or return()). No further source pulls are issued. This is
  // the whole lifecycle: while not finished the source is necessarily live, and
  // every terminal transition flips it true in the same synchronous step, so
  // there is no separate "finished but source still live" state to track.
  #finished = false;

  // A predicate error whose source close (it.return()) has not yet settled, but
  // which has already reached the head of the queue and so been committed to its
  // consumer call: { call, error }. Its recipient is fixed (a head error cannot be
  // dropped onto an earlier call), so the values behind it are delivered to the
  // later calls right away, while this one call waits for the close to settle and
  // is then rejected. At most one such deferral exists at a time — only the single
  // terminal predicate error closes the source.
  #deferredError = null;

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
    if (typeof this.#it.return !== 'function') return undefined;
    return this.#it.return();
  }

  // Close the source for a predicate error, invoking `onClosed` once the
  // it.return() result settles. Per the async-iteration model the error must
  // not be surfaced to a consumer until that close completes, so the erroring
  // position is withheld (see #predErrored) until this callback fires. The
  // close result itself — a value or a rejection — is swallowed; we only care
  // about *when* it settles. A missing it.return(), a synchronous throw, or a
  // non-thenable result is already settled, so `onClosed` runs synchronously.
  #closeSourceForError(onClosed) {
    let r;
    try {
      r = this.#closeSource();
    } catch {
      onClosed(); // synchronous throw: already settled, swallow it
      return;
    }
    if (r && typeof r.then === 'function') {
      r.then(onClosed, onClosed); // swallow value/rejection; release on settle
    } else {
      onClosed(); // no it.return() or a synchronous result: already settled
    }
  }

  // ---- pulling ----------------------------------------------------------

  // Issue one source pull, appended as a new position at the back of the queue.
  // A synchronous throw from it.next() is a source error at that position.
  #issuePull() {
    const pos = {
      status: 'pending',
      value: undefined,
      error: undefined,
      removed: false,
      heldForClose: false,
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

    Promise.resolve(result).then(
      (r) => this.#settlePull(pos, r),
      (e) => this.#rejectPull(pos, e)
    );
  }

  #settlePull(pos, result) {
    if (pos.removed) return; // discarded
    if (result && result.done) {
      this.#handleDone(pos);
    } else {
      this.#invokePred(pos, result ? result.value : undefined);
    }
  }

  #rejectPull(pos, err) {
    if (pos.removed) return; // discarded
    // Source error: positional error, does not close the source.
    pos.status = 'error';
    pos.error = err;
    this.#finished = true; // never call it.return() after a source error.
    this.#process();
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
        if (pos.removed) return;
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
    if (pos.removed) return; // discarded
    pos.status = 'error';
    pos.error = err;
    const wasLive = !this.#finished; // is this error the terminal event?
    this.#finished = true;
    if (wasLive) {
      // This error is the terminal event, so it closes the source. The error
      // must not be surfaced to its consumer until that it.return() settles, so
      // mark it held: #process will commit it to its call but defer the rejection
      // until the close completes (only the rejection waits — the values behind it
      // are not held). If the source had already ended on its own (not wasLive)
      // there is no close and nothing to wait for.
      pos.heldForClose = true;
      this.#closeSourceForError(() => {
        pos.heldForClose = false;
        // If the error already reached the head and was committed to a call,
        // reject it now that the close has settled. Otherwise it is still behind a
        // pending position and will be delivered in order once it reaches the head
        // (heldForClose is now clear, so #process no longer defers it).
        if (this.#deferredError) {
          const { call, error } = this.#deferredError;
          this.#deferredError = null;
          call.reject(error);
        }
        this.#process();
      });
    }
    this.#process();
  }

  // ---- drops and done ---------------------------------------------------

  #handleDrop(pos) {
    if (pos.removed) return;
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

  #handleDone(pos) {
    if (pos.removed) return;
    // This done is the terminal wall: discard its position and every later one
    // (overriding any later error or later done). Pop from the back until the
    // done record itself is popped. `pos` is still pending here (a pending head
    // blocks delivery), so it has not been shifted off the front and the
    // pop-loop reaches it; earlier positions are left untouched.
    let removed;
    do {
      removed = this.#positions.pop();
      removed.removed = true;
      // Tombstoned drops were already counted out of #liveCount.
      if (removed.status !== 'dropped') this.#liveCount--;
    } while (removed !== pos);
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
        if (pos.heldForClose) {
          // The source close this predicate error triggered has not settled yet.
          // Unlike a pending position, a head error has a fixed recipient (it
          // cannot be dropped onto an earlier call), so commit it to the head call
          // and defer the rejection until the close settles — without blocking the
          // values behind it, which keep flowing to the later calls below.
          this.#deferredError = { call: this.#calls.shift(), error: pos.error };
        } else {
          this.#calls.shift().reject(pos.error);
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

export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

class FilterHelper {
  #it;
  #pred;

  // TODO rename to InFlight
  // Positions is an ordered queue of results or placeholders for results,
  // held in a Set: insertion order is pull order, so the head is the
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

  #finished = false;

  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

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
      // TODO reconsider whether this really needs to happen same-tick
      // we could instead fold it into the rejection case
      pos.status = 'error';
      pos.error = e;
      pos.closeState = 'ready'
      this.#finished = true;
      // source faulted so we do not call it.return().
      // don't need to call #processQueue because callers are about to anyway.
      return;
    }

    Promise.resolve(result).then(
      (r) => {
        if (this.#isIgnored(pos)) return;
        // TODO handle errors from reading `done`/`value` properties
        if (r.done) {
          // A done is the terminal wall: discard its position and every later one
          // (overriding any later value, later error, or later done).
          //
          // This is theoretically quadratic in the degree of concurrency: if we issue
          // N pulls and they all settle with { done: true } back-to-front, then
          // we will do N steps in this loop the first time, N-1 the second, etc.
          // In practice this is unlikely to matter.
          // A native implementation could probably avoid that cost.
          let discarding = false;
          for (const n of this.#positions) {
            if (n === pos) discarding = true;
            if (discarding) this.#positions.delete(n);
          }
          this.#finished = true; // a clean done does not close the source.
          this.#processQueue();
          const drained = this.#calls.splice(this.#positions.size);
          for (const call of drained) {
            call.resolve({ value: undefined, done: true });
          }
        } else {
          this.#invokePred(pos, r.value);
        }
      },
      (e) => {
        if (this.#isIgnored(pos)) return;
        pos.status = 'error';
        pos.error = e;
        pos.closeState = 'ready';
        this.#finished = true;
        // source faulted so we do not call it.return().
        this.#processQueue();
      }
    );
  }

  #invokePred(pos, value) {
    pos.value = value;
    // The predicate is *called* synchronously (so the call is observed in pull
    // order), but its outcome is always handled one microtask hop later. A
    // synchronous throw is funneled through a rejected promise so it takes the
    // exact same deferred path as an asynchronous rejection — the source close
    // it triggers then lands after any delivery this same step unblocked.
    //
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
          this.#positions.delete(pos);
          if (!this.#finished) {
            // Source still open: replace the lost value with a fresh pull, so the
            // queue stays balanced and no call can become surplus.
            this.#issuePull();
            this.#processQueue();
          } else {
            // Source already closed: no replacement pull. In a quiescent state
            // #calls and #positions are equal in length, and we just removed one
            // position without removing a call, so there is now exactly one
            // surplus call, which we can settle.
            this.#processQueue();
            this.#calls.pop().resolve({ value: undefined, done: true });
          }
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
            r = this.#it.return?.();
          } catch {
            // synchronous throw from it.return() gets swallowed
          }
          // TODO Promise.resolve? if not, handle errors from .then
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

  // Deliver no-longer-awaiting values/errors from the head, in order.
  #processQueue() {
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
    this.#issuePull();

    // TODO reconsider whether this is the appropriate place for this
    // as opposed to triggering when the head of queue changes state
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
      r = this.#it.return?.();
    } catch (e) {
      this.#processQueue(); // TODO why are we calling this here...
      return Promise.reject(e);
    }

    this.#processQueue();

    return Promise.resolve(r).then(() => ({ value, done: true }));
  }
}

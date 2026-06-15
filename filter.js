export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

class FilterHelper {
  #it;
  #pred;

  // Slots is an ordered queue of results or placeholders for results,
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
  #slots = new Set();

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
    this.#slots.add(pos);
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
      if (this.#calls.length === 1) {
        // i.e. this is the only thing in the queue
        this.#processQueue();
      }
      return;
    }

    Promise.resolve(result).then(
      (r) => {
        if (this.#isIgnored(pos)) return;
        // TODO handle errors from reading `done`/`value` properties
        if (r.done) {
          // This is theoretically quadratic in the degree of concurrency: if we issue
          // N pulls and they all settle with { done: true } back-to-front, then
          // we will do N steps in this loop the first time, N-1 the second, etc.
          // In practice this is unlikely to matter.
          // A native implementation could probably avoid that cost.
          let discarding = false;
          for (const n of this.#slots) {
            if (n === pos) discarding = true;
            if (discarding) this.#slots.delete(n);
          }
          this.#finished = true; // a clean done does not close the source.
          this.#processQueue();
          const drained = this.#calls.splice(this.#slots.size);
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
          const isHead = this.#head() === pos;
          this.#slots.delete(pos);
          if (!this.#finished) {
            this.#issuePull();
          } else {
            this.#calls.pop().resolve({ value: undefined, done: true });
          }
          if (isHead) {
            this.#processQueue();
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

  #processQueue() {
    while (this.#calls.length > 0 && this.#slots.size > 0) {
      const pos = this.#head();
      if (pos.status === 'value') {
        this.#slots.delete(pos);
        this.#calls.shift().resolve({ value: pos.value, done: false });
      } else if (pos.status === 'error') {
        this.#slots.delete(pos);
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

  #head() {
    return this.#slots.values().next().value;
  }

  // A settlement is stale if its position is no longer in the queue, which can
  // only mean a terminal `done` wall discarded it.
  #isIgnored(pos) {
    return !this.#slots.has(pos);
  }

  // ---- consumer-facing iterator ----------------------------------------

  next() {
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    const { resolve, reject, promise } = Promise.withResolvers();
    this.#calls.push({ resolve, reject });
    this.#issuePull();

    return promise;
  }

  return() {
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    this.#finished = true;

    let r;
    try {
      r = this.#it.return?.();
    } catch (e) {
      return Promise.reject(e);
    }

    return Promise.resolve(r).then(() => ({ value: undefined, done: true }));
  }
}

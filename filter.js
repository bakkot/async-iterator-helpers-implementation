// filter(it, pred) — see filter-spec.md
//
// Returns a new async iterator (a FilterHelper) that yields the values of the
// async iterator `it` for which the (possibly async) predicate `pred` returns a
// truthy value, dropping the rest. The result supports concurrent `next()`
// calls.
//
// Internal model (per the spec):
//
//   * We keep an ordered list of `#positions`, one per in-flight source pull, in
//     pull order. Each position is `pending`, then resolves to a `value`, an
//     `error`, or a `done` (the terminal wall). Drops are removed eagerly and,
//     while live, replaced in place by a fresh pull.
//   * We keep a FIFO of outstanding consumer `next()` calls (`#calls`).
//   * While the result is live, #positions === #outstanding calls.
//   * Delivery happens strictly at the head of `#positions`, in call order:
//     a head `value` resolves the front call, a head `error` rejects it.
//   * Once finished, the "value ceiling" releases trailing (most-recently made)
//     calls to `{done:true}` whenever there are more outstanding calls than
//     deliverable positions.

function noop() {}

class FilterHelper {
  // The source async iterator and the predicate.
  #it;
  #pred;

  // Ordered list of positions, in pull order.
  //   pos = { status: 'pending'|'value'|'error'|'done', value, error, valid }
  // `valid` becomes false when a position is discarded (after a done wall) or
  // removed (drop); late settlements for such positions are ignored.
  #positions = [];

  // FIFO of outstanding consumer next() calls: { resolve, reject }.
  #calls = [];

  // True once a terminal event has occurred (source done, source error,
  // predicate error, or return()). No further source pulls are issued.
  #finished = false;

  // True while the source has neither completed (done/error) nor been closed by
  // us via it.return(). Guards the "close exactly once, only while live" rule.
  #sourceLive = true;

  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

  // ---- source closing ---------------------------------------------------

  // Fire-and-forget close, used by predicate errors. Closes at most once and
  // only while the source is still live.
  #closeSourceFireAndForget() {
    if (!this.#sourceLive) return;
    this.#sourceLive = false;
    if (typeof this.#it.return !== 'function') return;
    let r;
    try {
      r = this.#it.return();
    } catch (e) {
      return; // swallow
    }
    if (r && typeof r.then === 'function') {
      r.then(noop, noop); // swallow any rejection
    }
  }

  // ---- pulling ----------------------------------------------------------

  // Issue a single source pull, inserting its position at `index`. Returns the
  // new position. A synchronous throw from it.next() is a source error at that
  // position. Callers must run #process() afterward.
  #issuePull(index) {
    const pos = {
      status: 'pending',
      value: undefined,
      error: undefined,
      valid: true,
    };
    this.#positions.splice(index, 0, pos);

    let result;
    try {
      result = this.#it.next();
    } catch (e) {
      // Synchronous throw: a source error at this position.
      pos.status = 'error';
      pos.error = e;
      this.#finished = true;
      this.#sourceLive = false; // source faulted; never call it.return().
      return pos;
    }

    Promise.resolve(result).then(
      (r) => this.#settlePull(pos, r),
      (e) => this.#rejectPull(pos, e)
    );
    return pos;
  }

  #settlePull(pos, result) {
    if (!pos.valid) return; // discarded
    if (result && result.done) {
      this.#handleDone(pos);
    } else {
      this.#invokePred(pos, result ? result.value : undefined);
    }
  }

  #rejectPull(pos, err) {
    if (!pos.valid) return; // discarded
    // Source error: positional error, does not close the source.
    pos.status = 'error';
    pos.error = err;
    this.#finished = true;
    this.#sourceLive = false; // never call it.return() after a source error.
    this.#process();
  }

  // ---- predicate --------------------------------------------------------

  #invokePred(pos, value) {
    pos.value = value;
    let res;
    try {
      res = this.#pred(value);
    } catch (e) {
      this.#predErrored(pos, e);
      return;
    }
    Promise.resolve(res).then(
      (keep) => {
        if (!pos.valid) return;
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
    if (!pos.valid) return; // discarded
    pos.status = 'error';
    pos.error = err;
    this.#finished = true;
    // A predicate error closes the source (fire-and-forget) if still live.
    this.#closeSourceFireAndForget();
    this.#process();
  }

  // ---- drops and done ---------------------------------------------------

  #handleDrop(pos) {
    if (!pos.valid) return;
    const idx = this.#positions.indexOf(pos);
    if (idx < 0) return;
    pos.valid = false;
    this.#positions.splice(idx, 1);
    if (!this.#finished) {
      // Still live: replace the dropped position in place.
      this.#issuePull(idx);
    }
    // If finished, the position is simply gone; the value ceiling in #process()
    // will release a trailing call to done.
    this.#process();
  }

  #handleDone(pos) {
    if (!pos.valid) return;
    const idx = this.#positions.indexOf(pos);
    if (idx < 0) return;
    // This done is the terminal wall. Discard every later position (overriding
    // any later error or later done), keeping this position as the wall.
    for (let i = idx + 1; i < this.#positions.length; i++) {
      this.#positions[i].valid = false;
    }
    this.#positions.length = idx + 1;
    pos.status = 'done';
    this.#finished = true;
    this.#sourceLive = false; // a clean done does not close the source.
    this.#process();
  }

  // ---- delivery ---------------------------------------------------------

  // Number of still-deliverable positions (everything before the terminal
  // wall): pending, value, or error. The done wall is not counted.
  #deliverableCount() {
    let v = 0;
    for (let i = 0; i < this.#positions.length; i++) {
      const s = this.#positions[i].status;
      if (s === 'pending' || s === 'value' || s === 'error') v++;
    }
    return v;
  }

  #process() {
    // 1) Deliver from the head, in order: values and errors only. A pending
    //    head blocks everything behind it.
    while (this.#calls.length > 0 && this.#positions.length > 0) {
      const pos = this.#positions[0];
      if (pos.status === 'value') {
        this.#positions.shift();
        const call = this.#calls.shift();
        call.resolve({ value: pos.value, done: false });
      } else if (pos.status === 'error') {
        this.#positions.shift();
        const call = this.#calls.shift();
        call.reject(pos.error);
      } else {
        // pending or the done wall: stop.
        break;
      }
    }

    // 2) Once finished, the value ceiling releases trailing (most-recently
    //    made) calls to done whenever outstanding calls exceed deliverable
    //    positions.
    if (this.#finished) {
      const v = this.#deliverableCount();
      while (this.#calls.length > v) {
        const call = this.#calls.pop();
        call.resolve({ value: undefined, done: true });
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
    this.#issuePull(this.#positions.length); // one pull per next(), at the tail.
    this.#process();
    return p;
  }

  return(value) {
    if (this.#finished) {
      return Promise.resolve({ value, done: true });
    }
    this.#finished = true;

    // Close the source exactly once, if still live, before resolving.
    let r;
    if (this.#sourceLive) {
      this.#sourceLive = false;
      if (typeof this.#it.return === 'function') {
        try {
          r = this.#it.return();
        } catch (e) {
          this.#process();
          return Promise.reject(e);
        }
      }
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

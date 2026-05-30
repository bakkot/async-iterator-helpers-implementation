// filter(it, pred) — see filter-spec.md
//
// Returns a new async iterator that yields the values of the async iterator
// `it` for which the (possibly async) predicate `pred` returns a truthy value,
// dropping the rest. The result supports concurrent `next()` calls.
//
// Internal model (per the spec):
//
//   * We keep an ordered list of `positions`, one per in-flight source pull, in
//     pull order. Each position is `pending`, then resolves to a `value`, an
//     `error`, or a `done` (the terminal wall). Drops are removed eagerly and,
//     while live, replaced in place by a fresh pull.
//   * We keep a FIFO of outstanding consumer `next()` calls (`calls`).
//   * While the result is live, #positions === #outstanding calls.
//   * Delivery happens strictly at the head of `positions`, in call order:
//     a head `value` resolves the front call, a head `error` rejects it.
//   * Once `finished`, the "value ceiling" releases trailing (most-recently
//     made) calls to `{done:true}` whenever there are more outstanding calls
//     than deliverable positions.

export default function filter(it, pred) {
  // Ordered list of positions, in pull order.
  //   pos = { status: 'pending'|'value'|'error'|'done', value, error, valid }
  // `valid` becomes false when a position is discarded (after a done wall) or
  // removed (drop); late settlements for such positions are ignored.
  const positions = [];

  // FIFO of outstanding consumer next() calls: { resolve, reject }.
  const calls = [];

  // True once a terminal event has occurred (source done, source error,
  // predicate error, or return()). No further source pulls are issued.
  let finished = false;

  // True while the source has neither completed (done/error) nor been closed
  // by us via it.return(). Guards the "close exactly once, only while live"
  // rule.
  let sourceLive = true;

  // ---- source closing ---------------------------------------------------

  // Fire-and-forget close, used by predicate errors. Closes at most once and
  // only while the source is still live.
  function closeSourceFireAndForget() {
    if (!sourceLive) return;
    sourceLive = false;
    if (typeof it.return !== 'function') return;
    let r;
    try {
      r = it.return();
    } catch (e) {
      return; // swallow
    }
    if (r && typeof r.then === 'function') {
      r.then(noop, noop); // swallow any rejection
    }
  }

  function noop() {}

  // ---- pulling ----------------------------------------------------------

  // Issue a single source pull, inserting its position at `index`. Returns the
  // new position. A synchronous throw from it.next() is a source error at that
  // position. Callers must run process() afterward.
  function issuePull(index) {
    const pos = {
      status: 'pending',
      value: undefined,
      error: undefined,
      valid: true,
    };
    positions.splice(index, 0, pos);

    let result;
    try {
      result = it.next();
    } catch (e) {
      // Synchronous throw: a source error at this position.
      pos.status = 'error';
      pos.error = e;
      finished = true;
      sourceLive = false; // source faulted; never call it.return().
      return pos;
    }

    Promise.resolve(result).then(
      (r) => settlePull(pos, r),
      (e) => rejectPull(pos, e)
    );
    return pos;
  }

  function settlePull(pos, result) {
    if (!pos.valid) return; // discarded
    if (result && result.done) {
      handleDone(pos);
    } else {
      invokePred(pos, result ? result.value : undefined);
    }
  }

  function rejectPull(pos, err) {
    if (!pos.valid) return; // discarded
    // Source error: positional error, does not close the source.
    pos.status = 'error';
    pos.error = err;
    finished = true;
    sourceLive = false; // never call it.return() after a source error.
    process();
  }

  // ---- predicate --------------------------------------------------------

  function invokePred(pos, value) {
    pos.value = value;
    let res;
    try {
      res = pred(value);
    } catch (e) {
      predErrored(pos, e);
      return;
    }
    Promise.resolve(res).then(
      (keep) => {
        if (!pos.valid) return;
        if (keep) {
          pos.status = 'value';
          process();
        } else {
          handleDrop(pos);
        }
      },
      (e) => predErrored(pos, e)
    );
  }

  function predErrored(pos, err) {
    if (!pos.valid) return; // discarded
    pos.status = 'error';
    pos.error = err;
    finished = true;
    // A predicate error closes the source (fire-and-forget) if still live.
    closeSourceFireAndForget();
    process();
  }

  // ---- drops and done ---------------------------------------------------

  function handleDrop(pos) {
    if (!pos.valid) return;
    const idx = positions.indexOf(pos);
    if (idx < 0) return;
    pos.valid = false;
    positions.splice(idx, 1);
    if (!finished) {
      // Still live: replace the dropped position in place.
      issuePull(idx);
    }
    // If finished, the position is simply gone; the value ceiling in process()
    // will release a trailing call to done.
    process();
  }

  function handleDone(pos) {
    if (!pos.valid) return;
    const idx = positions.indexOf(pos);
    if (idx < 0) return;
    // This done is the terminal wall. Discard every later position (overriding
    // any later error or later done), keeping this position as the wall.
    for (let i = idx + 1; i < positions.length; i++) {
      positions[i].valid = false;
    }
    positions.length = idx + 1;
    pos.status = 'done';
    finished = true;
    sourceLive = false; // a clean done does not close the source.
    process();
  }

  // ---- delivery ---------------------------------------------------------

  // Number of still-deliverable positions (everything before the terminal
  // wall): pending, value, or error. The done wall is not counted.
  function deliverableCount() {
    let v = 0;
    for (let i = 0; i < positions.length; i++) {
      const s = positions[i].status;
      if (s === 'pending' || s === 'value' || s === 'error') v++;
    }
    return v;
  }

  function process() {
    // 1) Deliver from the head, in order: values and errors only. A pending
    //    head blocks everything behind it.
    while (calls.length > 0 && positions.length > 0) {
      const pos = positions[0];
      if (pos.status === 'value') {
        positions.shift();
        const call = calls.shift();
        call.resolve({ value: pos.value, done: false });
      } else if (pos.status === 'error') {
        positions.shift();
        const call = calls.shift();
        call.reject(pos.error);
      } else {
        // pending or the done wall: stop.
        break;
      }
    }

    // 2) Once finished, the value ceiling releases trailing (most-recently
    //    made) calls to done whenever outstanding calls exceed deliverable
    //    positions.
    if (finished) {
      const v = deliverableCount();
      while (calls.length > v) {
        const call = calls.pop();
        call.resolve({ value: undefined, done: true });
      }
    }
  }

  // ---- consumer-facing iterator ----------------------------------------

  const result = {
    next() {
      if (finished) {
        return Promise.resolve({ value: undefined, done: true });
      }
      let resolve, reject;
      const p = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      calls.push({ resolve, reject });
      issuePull(positions.length); // one pull per next(), at the tail.
      process();
      return p;
    },

    return(value) {
      if (finished) {
        return Promise.resolve({ value, done: true });
      }
      finished = true;

      // Close the source exactly once, if still live, before resolving.
      let r;
      if (sourceLive) {
        sourceLive = false;
        if (typeof it.return === 'function') {
          try {
            r = it.return();
          } catch (e) {
            process();
            return Promise.reject(e);
          }
        }
      }

      // Outstanding calls keep their in-flight pulls; the ceiling governs them.
      process();

      return Promise.resolve(r).then(() => ({ value, done: true }));
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return result;
}

export { filter };

// filter(it, pred) — see filter-spec.md
//
// Returns a new async iterator (a FilterHelper) that yields the values of the
// async iterator `it` for which the (possibly async) predicate `pred` returns a
// truthy value, dropping the rest. The result supports concurrent `next()`
// calls.
//
// Internal model (per the spec):
//
//   * `#positions` is an ordered list of positions, one per in-flight source
//     pull, in pull order. Each position is `pending`, then resolves to a
//     `value` or an `error`. Drops are removed eagerly and, while live, replaced
//     in place by a fresh pull. A source `done` is the terminal wall: its
//     position and every later one are discarded.
//   * `#calls` is a FIFO of outstanding consumer `next()` calls.
//   * While the result is live, #positions and #calls have equal length and are
//     aligned by index from the head.
//   * Delivery happens strictly at the head of `#positions`, in call order: a
//     head `value` resolves the front call, a head `error` rejects it.
//   * `#positions` only ever holds still-deliverable positions, so its size is
//     the "value ceiling" V. Once finished, the ceiling releases trailing
//     (most-recently made) calls to `{done:true}` whenever there are more
//     outstanding calls than positions.
//
// Both lists are intrusive doubly-linked lists so that every operation the
// model needs — push/shift/pop at the ends, plus arbitrary remove, in-place
// replace, and discard-to-end for positions — is O(1) (the done-wall discard is
// O(number discarded)).

function noop() {}

class ListNode {
  prev = null;
  next = null;
  removed = false;

  constructor(value) {
    this.value = value;
  }
}

class LinkedList {
  #head = null;
  #tail = null;
  #size = 0;

  get size() {
    return this.#size;
  }

  isEmpty() {
    return this.#size === 0;
  }

  // Value at the head, or undefined if empty.
  peekHead() {
    return this.#head ? this.#head.value : undefined;
  }

  pushTail(value) {
    const node = new ListNode(value);
    node.prev = this.#tail;
    if (this.#tail) this.#tail.next = node;
    else this.#head = node;
    this.#tail = node;
    this.#size++;
    return node;
  }

  shiftHead() {
    const node = this.#head;
    if (node) this.remove(node);
    return node ? node.value : undefined;
  }

  popTail() {
    const node = this.#tail;
    if (node) this.remove(node);
    return node ? node.value : undefined;
  }

  remove(node) {
    if (node.removed) return;
    node.removed = true;
    if (node.prev) node.prev.next = node.next;
    else this.#head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.#tail = node.prev;
    node.prev = node.next = null;
    this.#size--;
  }

  // Remove `node` and every node after it.
  removeFrom(node) {
    if (node.removed) return;
    const before = node.prev;
    let cur = node;
    while (cur) {
      cur.removed = true;
      const next = cur.next;
      cur.prev = cur.next = null;
      this.#size--;
      cur = next;
    }
    if (before) before.next = null;
    else this.#head = null;
    this.#tail = before;
  }
}

class FilterHelper {
  // The source async iterator and the predicate.
  #it;
  #pred;

  // Positions in pull order. Each value is a record { status, value, error }
  // with status one of 'pending' | 'value' | 'error'. The list holds only
  // still-deliverable positions, so #positions.size is the value ceiling.
  #positions = new LinkedList();

  // Outstanding consumer next() calls in call order; each value is
  // { resolve, reject }.
  #calls = new LinkedList();

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

  // Drive a source pull for an already-inserted position node. A synchronous
  // throw from it.next() is a source error at that position. Callers run
  // #process() afterward.
  #startPull(node) {
    let result;
    try {
      result = this.#it.next();
    } catch (e) {
      // Synchronous throw: a source error at this position.
      node.value.status = 'error';
      node.value.error = e;
      this.#finished = true;
      this.#sourceLive = false; // source faulted; never call it.return().
      return;
    }

    Promise.resolve(result).then(
      (r) => this.#settlePull(node, r),
      (e) => this.#rejectPull(node, e)
    );
  }

  #settlePull(node, result) {
    if (node.removed) return; // discarded
    if (result && result.done) {
      this.#handleDone(node);
    } else {
      this.#invokePred(node, result ? result.value : undefined);
    }
  }

  #rejectPull(node, err) {
    if (node.removed) return; // discarded
    // Source error: positional error, does not close the source.
    node.value.status = 'error';
    node.value.error = err;
    this.#finished = true;
    this.#sourceLive = false; // never call it.return() after a source error.
    this.#process();
  }

  // ---- predicate --------------------------------------------------------

  #invokePred(node, value) {
    node.value.value = value;
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
        if (node.removed) return;
        if (keep) {
          node.value.status = 'value';
          this.#process();
        } else {
          this.#handleDrop(node);
        }
      },
      (e) => this.#predErrored(node, e)
    );
  }

  #predErrored(node, err) {
    if (node.removed) return; // discarded
    node.value.status = 'error';
    node.value.error = err;
    this.#finished = true;
    // A predicate error closes the source (fire-and-forget) if still live.
    this.#closeSourceFireAndForget();
    this.#process();
  }

  // ---- drops and done ---------------------------------------------------

  #handleDrop(node) {
    if (node.removed) return;
    // The dropped position is removed and the queue compacts: surviving values
    // are delivered strictly in pull order, so an already-known later value
    // shifts forward to the earliest waiting call.
    this.#positions.remove(node);
    if (!this.#finished) {
      // Still live: the outstanding call still needs a value, so issue a fresh
      // pull at the BACK of the queue. It does not take the dropped slot — its
      // value is just another candidate, behind everything already pulled.
      this.#startPull(this.#positions.pushTail(makePosition()));
    }
    // If finished, the position is simply gone; the value ceiling in #process()
    // will release a trailing call to done.
    this.#process();
  }

  #handleDone(node) {
    if (node.removed) return;
    // This done is the terminal wall: discard its position and every later one
    // (overriding any later error or later done).
    this.#positions.removeFrom(node);
    this.#finished = true;
    this.#sourceLive = false; // a clean done does not close the source.
    this.#process();
  }

  // ---- delivery ---------------------------------------------------------

  #process() {
    // 1) Deliver from the head, in order. A pending head blocks everything
    //    behind it.
    while (!this.#calls.isEmpty() && !this.#positions.isEmpty()) {
      const pos = this.#positions.peekHead();
      if (pos.status === 'value') {
        this.#positions.shiftHead();
        this.#calls.shiftHead().resolve({ value: pos.value, done: false });
      } else if (pos.status === 'error') {
        this.#positions.shiftHead();
        this.#calls.shiftHead().reject(pos.error);
      } else {
        break; // pending
      }
    }

    // 2) Once finished, the value ceiling (#positions.size) releases the
    //    trailing (most-recently made) calls that exceed it to done. They are
    //    settled in call order, even though it is the latest calls being
    //    retired.
    if (this.#finished) {
      const surplus = this.#calls.size - this.#positions.size;
      if (surplus > 0) {
        const drained = [];
        for (let i = 0; i < surplus; i++) drained.push(this.#calls.popTail());
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
    this.#calls.pushTail({ resolve, reject });
    this.#startPull(this.#positions.pushTail(makePosition())); // one pull per next().
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

function makePosition() {
  return { status: 'pending', value: undefined, error: undefined };
}

export default function filter(it, pred) {
  return new FilterHelper(it, pred);
}

export { filter, FilterHelper };

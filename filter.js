export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

class FilterHelper {
  #done = false;
  #it;
  #pred;
  // One slot per underlying pull, in pull order. status is
  // 'pending' | 'value' | 'drop' | 'done' | 'error'.
  #slots = [];
  // Next slot to hand out, in order. The i-th passing value goes to the i-th
  // consumer call, so values are delivered strictly in call order.
  #cursor = 0;
  // Waiting consumer deferreds, each tagged with its absolute call position.
  #consumers = [];
  #made = 0;
  // Exclusive index past which no value can exist, set when a done is seen: a
  // done at index d caps it at d (the done slot itself yields nothing). A well-
  // behaved source keeps returning done, so the pulls already in flight past d
  // would resolve done too — capping just lets trailing calls settle done ASAP,
  // even while an earlier one is still blocked. Errors do NOT cap it (see #fail).
  #boundary = null;
  // The value ceiling: how many value-positions exist below #boundary.
  // Maintained incrementally so #drainDone need not rescan — each drop before
  // the boundary lowers it. A call whose position reaches it can never receive a
  // value. Only meaningful once #boundary is set.
  #upper = 0;

  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

  next() {
    if (this.#done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    const d = Promise.withResolvers();
    d.position = this.#made++;
    this.#consumers.push(d);
    this.#pull();
    return d.promise;
  }

  async return() {
    if (this.#done) {
      return { value: undefined, done: true };
    }
    this.#done = true;
    await this.#it?.return();
    return { value: undefined, done: true };
  }

  // Issue one underlying pull. Called once per consumer call and once more per
  // dropped value (to replace it), but never once we're done.
  #pull() {
    const slot = { status: 'pending', value: undefined, error: undefined };
    const k = this.#slots.length;
    this.#slots.push(slot);
    new Promise(resolve => resolve(this.#it.next())).then(settled => {
      let value, done;
      try {
        ({ value, done } = settled);
      } catch (err) {
        // A throwing result object is an error *from* the underlying: surface
        // it, but never close.
        this.#done = true;
        this.#fail(slot, err);
        return;
      }
      if (done) {
        // Clean exhaustion: done, but the underlying is not closed.
        this.#done = true;
        if (this.#boundary === null || k < this.#boundary) {
          this.#boundary = k;
          this.#recomputeUpper();
        }
        this.#pump();
        this.#drainDone();
        return;
      }
      new Promise(resolve => resolve(this.#pred(value))).then(keep => {
        if (keep) {
          slot.status = 'value';
          slot.value = value;
          this.#pump();
        } else {
          // A drop lowers the value ceiling, so it can both reissue a pull (to
          // replace the lost value) and let trailing done calls settle.
          slot.status = 'drop';
          if (this.#boundary !== null && k < this.#boundary) this.#upper--;
          if (!this.#done) this.#pull();
          this.#pump();
          this.#drainDone();
        }
      }, err => {
        // A predicate error is treated like `true` (the value still fills its
        // position) except that position rejects, future next() calls get done,
        // and the underlying is closed — the last only if still live.
        if (!this.#done) {
          this.#done = true;
          this.#close();
        }
        this.#fail(slot, err);
      });
    }, err => {
      // Error from the underlying's .next(): surface it, but never close.
      this.#done = true;
      this.#fail(slot, err);
    });
  }

  // Deliver settled slots to waiting consumers in order.
  #pump() {
    while (this.#consumers.length > 0) {
      const slot = this.#slots[this.#cursor];
      if (!slot || slot.status === 'pending') break;
      if (slot.status === 'value') {
        this.#consumers.shift().resolve({ value: slot.value, done: false });
        this.#cursor++;
      } else if (slot.status === 'drop') {
        this.#cursor++;
      } else if (slot.status === 'done') {
        for (const c of this.#consumers) c.resolve({ value: undefined, done: true });
        this.#consumers.length = 0;
      } else {
        // 'error': like a value, but the call at this position rejects. It does
        // not end the others — they keep being served — so advance and continue.
        this.#consumers.shift().reject(slot.error);
        this.#cursor++;
      }
    }
  }

  // Settle trailing calls that can no longer receive a value: those whose
  // position has reached the value ceiling. Only does anything once a boundary
  // is known. The call at the ceiling's last position (an erroring one) stays —
  // it is rejected in order by #pump.
  #drainDone() {
    if (this.#boundary === null) return;
    while (this.#consumers.length > 0 &&
           this.#consumers[this.#consumers.length - 1].position >= this.#upper) {
      this.#consumers.pop().resolve({ value: undefined, done: true });
    }
  }

  // Count the value-positions below #boundary: every slot that is not a drop —
  // a value, a still-pending pull, or an error (which fills its position with a
  // rejection). A done slot never falls below the boundary. Runs only when the
  // boundary is first set or lowered.
  #recomputeUpper() {
    let upper = 0;
    for (let i = 0; i < this.#boundary; i++) {
      if (this.#slots[i].status !== 'drop') upper++;
    }
    this.#upper = upper;
  }

  // Record an error at a slot: it keeps its value-position and is rejected in
  // order by #pump. Unlike a done it does NOT cap the boundary — an error only
  // ends *future* next() calls (via #done); calls already vended stay served by
  // the pulls already in flight, so their values are not lost.
  #fail(slot, err) {
    slot.status = 'error';
    slot.error = err;
    this.#pump();
  }

  #close() {
    try {
      // errors from .return() are swallowed, as in IteratorClose
      Promise.resolve(this.#it?.return()).then(undefined, () => {});
    } catch {}
  }
}

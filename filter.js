export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

class FilterHelper {
  #done = false;
  #it;
  #pred;
  // Slot[] where Slot =
  //   | { status: 'pending' | 'drop' | 'done', index: number }
  //   | { status: 'value', value: unknown, index: number }
  //   | { status: 'error', error: unknown, index: number }
  // One slot per underlying pull, in pull order.
  #slots = [];
  // Stable pull indexes let async completions find their current window index
  // without searching or renumbering the remaining slots after compaction.
  #slotBase = 0;
  // Waiting consumer deferreds, in call order.
  #consumers = [];
  // The value ceiling: the number of non-dropped slots that can still produce
  // values in the current slot window. Kept current as we go (a pull adds one;
  // a drop or settled head value removes one) so #drainDone never rescans.
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
    this.#consumers.push(d);
    this.#pull();
    return d.promise;
  }

  async return() {
    if (this.#done) {
      return { value: undefined, done: true };
    }
    this.#done = true;
    this.#drainDone();
    await this.#it?.return();
    return { value: undefined, done: true };
  }

  // Issue one underlying pull. Called once per consumer call and once more per
  // dropped value (to replace it), but never once we're done.
  #pull() {
    const slot = {
      status: 'pending',
      value: undefined,
      error: undefined,
      index: this.#slotBase + this.#slots.length,
    };
    this.#slots.push(slot);
    this.#upper++; // a new non-dropped slot in the current window
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
        slot.status = 'done';
        const k = this.#currentSlotIndex(slot);
        if (k !== null) {
          // The done slot and every later slot cannot produce values. Discount
          // that suffix and stop retaining later in-flight slots.
          for (let i = k; i < this.#slots.length; i++) {
            if (this.#slots[i].status !== 'drop') this.#upper--;
          }
          this.#slots.length = k + 1;
        }
        this.#pump();
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
          const k = this.#currentSlotIndex(slot);
          if (k !== null) this.#upper--;
          if (!this.#done) this.#pull();
          this.#pump();
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
      const slot = this.#slots[0];
      if (!slot || slot.status === 'pending') break;

      let consumesConsumer = false;
      switch (slot.status) {
        case 'value':
          this.#consumers.shift().resolve({ value: slot.value, done: false });
          consumesConsumer = true;
          break;
        case 'drop':
          break;
        case 'done':
          this.#drainDone();
          return;
        case 'error':
          // 'error': like a value, but the call at this position rejects. It
          // does not end the others — they keep being served — so advance and
          // continue.
          this.#consumers.shift().reject(slot.error);
          consumesConsumer = true;
          break;
      }

      this.#slots.shift();
      this.#slotBase++;
      if (consumesConsumer) {
        this.#upper--;
      }
    }
    if (this.#done) this.#drainDone();
  }

  // Settle trailing calls that can no longer receive a value: those whose
  // position has reached the terminal value ceiling. The call at the ceiling's
  // last position (an erroring one) stays — it is rejected in order by #pump.
  #drainDone() {
    while (this.#consumers.length > this.#upper) {
      this.#consumers.pop().resolve({ value: undefined, done: true });
    }
    if (this.#consumers.length === 0) {
      // No slot can become observable after terminal drain; drop references
      // eagerly while allowing already-issued pulls to finish harmlessly.
      this.#slotBase += this.#slots.length;
      this.#slots.length = 0;
      this.#upper = 0;
    }
  }

  // Record an error at a slot: it keeps its value-position and is rejected in
  // order by #pump. An error does not exhaust the source the way a done does, so
  // the pulls already in flight still serve their calls (values are not lost);
  // but no new pull will happen, so #done lets any call that would need one
  // settle done instead of hanging.
  #fail(slot, err) {
    slot.status = 'error';
    slot.error = err;
    this.#pump();
  }

  #currentSlotIndex(slot) {
    const index = slot.index - this.#slotBase;
    return index >= 0 && index < this.#slots.length ? index : null;
  }

  #close() {
    try {
      // errors from .return() are swallowed, as in IteratorClose
      Promise.resolve(this.#it?.return()).then(undefined, () => {});
    } catch {}
  }
}

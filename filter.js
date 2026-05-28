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
  // Earliest pull index that reported done, once one has. After a done the
  // sequence holds at most as many values as there are non-dropped earlier
  // slots, which lets trailing calls settle done while an earlier one blocks.
  #doneIndex = null;
  // That cap, maintained incrementally so #drainDone need not rescan: each drop
  // before the boundary lowers it. A call whose position reaches it can never
  // receive a value. Only meaningful once #doneIndex is set.
  #upper = 0;
  // Earliest slot to error; lets an in-order error (delivered by #pump) take
  // precedence over done-draining.
  #errorIndex = null;

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
        this.#recordError(slot, k, err);
        this.#pump();
        return;
      }
      if (done) {
        // Clean exhaustion: done, but the underlying is not closed.
        this.#done = true;
        if (this.#doneIndex === null || k < this.#doneIndex) {
          this.#doneIndex = k;
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
          if (this.#doneIndex !== null && k < this.#doneIndex) this.#upper--;
          if (!this.#done) this.#pull();
          this.#pump();
          this.#drainDone();
        }
      }, err => {
        // A predicate error closes the underlying, but only if still live.
        if (!this.#done) {
          this.#done = true;
          this.#close();
        }
        this.#recordError(slot, k, err);
        this.#pump();
      });
    }, err => {
      // Error from the underlying's .next(): surface it, but never close.
      this.#done = true;
      this.#recordError(slot, k, err);
      this.#pump();
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
        this.#consumers.shift().reject(slot.error);
        for (const c of this.#consumers) c.resolve({ value: undefined, done: true });
        this.#consumers.length = 0;
      }
    }
  }

  // After a done, settle trailing calls that can no longer receive a value.
  #drainDone() {
    if (this.#doneIndex === null) return;
    // An error before the done is delivered in order by #pump instead.
    if (this.#errorIndex !== null && this.#errorIndex < this.#doneIndex) return;
    while (this.#consumers.length > 0 &&
           this.#consumers[this.#consumers.length - 1].position >= this.#upper) {
      this.#consumers.pop().resolve({ value: undefined, done: true });
    }
  }

  // Count the values still reachable: slots before the done that haven't been
  // dropped. Runs only when the done-boundary is first set or lowered.
  #recomputeUpper() {
    let upper = 0;
    for (let i = 0; i < this.#doneIndex; i++) {
      const s = this.#slots[i];
      if (s.status === 'pending' || s.status === 'value') upper++;
    }
    this.#upper = upper;
  }

  #recordError(slot, k, err) {
    if (this.#errorIndex === null || k < this.#errorIndex) this.#errorIndex = k;
    slot.status = 'error';
    slot.error = err;
  }

  #close() {
    try {
      // errors from .return() are swallowed, as in IteratorClose
      Promise.resolve(this.#it?.return()).then(undefined, () => {});
    } catch {}
  }
}

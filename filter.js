export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

class FilterHelper {
  #done = false;
  #it;
  #pred;

  // The helper keeps a compact window of issued underlying pulls. Each consumer
  // receives the next slot in that window whose predicate passes; dropped slots
  // are skipped and replaced with another pull while the source is still live.
  //
  // Once #done is set, no replacement pulls will be issued. At that point
  // #valueLimit is a ceiling on how many waiting consumers can still receive
  // values/errors from the remaining window, so consumers beyond it can resolve
  // done immediately even if earlier slots are still pending.
  //
  // Core invariants:
  // - #slotBase is the stable index of #slots[0], if the window is non-empty.
  // - slot.index === #slotBase + its current offset, while retained.
  // - #valueLimit counts retained slots that can still consume one caller:
  //   'pending', 'value', and 'error'. It excludes 'drop' and the terminal
  //   'done' wall.
  // - 0 <= #valueLimit <= #slots.length.
  //
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
  // Kept current so #drainDone never rescans the slot window.
  #valueLimit = 0;

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
      index: this.#slotBase + this.#slots.length,
    };
    this.#slots.push(slot);
    this.#valueLimit++;
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
        const slotIndex = this.#retainedSlotIndex(slot);
        if (slotIndex !== null) {
          // The done slot and every later slot cannot produce values. Discount
          // that suffix and stop retaining later in-flight slots.
          for (let i = slotIndex; i < this.#slots.length; i++) {
            if (this.#slots[i].status !== 'drop') this.#valueLimit--;
          }
          this.#slots.length = slotIndex + 1;
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
          // A drop lowers the value ceiling. While live, replace the lost value
          // with another pull; after done, the lower ceiling may drain callers.
          slot.status = 'drop';
          const slotIndex = this.#retainedSlotIndex(slot);
          if (slotIndex !== null) this.#valueLimit--;
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

      let settledConsumer = false;
      switch (slot.status) {
        case 'value':
          this.#consumers.shift().resolve({ value: slot.value, done: false });
          settledConsumer = true;
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
          settledConsumer = true;
          break;
      }

      this.#slots.shift();
      this.#slotBase++;
      if (settledConsumer) {
        this.#valueLimit--;
      }
    }
    if (this.#done) this.#drainDone();
  }

  // Settle trailing calls that can no longer receive a value: those whose
  // position has reached the terminal value ceiling. The call at the ceiling's
  // last position (an erroring one) stays — it is rejected in order by #pump.
  #drainDone() {
    while (this.#consumers.length > this.#valueLimit) {
      this.#consumers.pop().resolve({ value: undefined, done: true });
    }
    if (this.#consumers.length === 0) {
      // No slot can become observable after terminal drain; drop references
      // eagerly while allowing already-issued pulls to finish harmlessly.
      this.#slotBase += this.#slots.length;
      this.#slots.length = 0;
      this.#valueLimit = 0;
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

  // Returns null for late completions whose slot was already compacted away.
  #retainedSlotIndex(slot) {
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

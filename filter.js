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
  // Waiting consumer deferreds, each tagged with its current queue position.
  #consumers = [];
  // Exclusive index past which no value can exist, once known. A clean done at
  // index d caps it at d (the done slot yields nothing, and a well-behaved
  // source keeps returning done, so any pulls in flight past d would too). An
  // error or return() instead seals it at the pulls already issued (#seal): no
  // further pulls will happen, so a call that would need one can never be served.
  // Either way, trailing calls settle done ASAP, even while an earlier one is
  // still blocked.
  #boundary = null;
  // The value ceiling: the number of non-dropped slots below #boundary in the
  // current slot window. Kept current as we go (a pull adds one; a drop or
  // settled head value removes one) so #drainDone never rescans. While
  // #boundary is null it counts every slot in the window, which is exactly the
  // count #seal wants. A call whose position reaches it can never get a value.
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
    d.position = this.#consumers.length;
    this.#consumers.push(d);
    this.#pull();
    return d.promise;
  }

  async return() {
    if (this.#done) {
      return { value: undefined, done: true };
    }
    this.#done = true;
    this.#seal();
    this.#drainDone();
    await this.#it?.return();
    return { value: undefined, done: true };
  }

  // Issue one underlying pull. Called once per consumer call and once more per
  // dropped value (to replace it), but never once we're done.
  #pull() {
    const slot = { status: 'pending', value: undefined, error: undefined };
    this.#slots.push(slot);
    this.#upper++; // a new non-dropped slot below the (not-yet-set) boundary
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
        const k = this.#slotIndex(slot);
        if (this.#boundary === null || k < this.#boundary) {
          // The boundary moves down to k; discount the slots it now excludes,
          // [k, oldEnd), that #upper was still counting (oldEnd = the previous
          // boundary, or every slot in the window if none was set).
          const oldEnd = this.#boundary ?? this.#slots.length;
          for (let i = k; i < oldEnd; i++) {
            if (this.#slots[i].status !== 'drop') this.#upper--;
          }
          this.#boundary = k;
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
          const k = this.#slotIndex(slot);
          if (this.#boundary === null || k < this.#boundary) this.#upper--;
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
      const slot = this.#slots[0];
      if (!slot || slot.status === 'pending') break;
      if (slot.status === 'value') {
        this.#consumers.shift().resolve({ value: slot.value, done: false });
        this.#settleHeadSlot();
      } else if (slot.status === 'drop') {
        this.#discardHeadSlot(false);
      } else if (slot.status === 'done') {
        break;
      } else {
        // 'error': like a value, but the call at this position rejects. It does
        // not end the others — they keep being served — so advance and continue.
        this.#consumers.shift().reject(slot.error);
        this.#settleHeadSlot();
      }
    }
    this.#drainDone();
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

  // Record an error at a slot: it keeps its value-position and is rejected in
  // order by #pump. An error does not exhaust the source the way a done does, so
  // the pulls already in flight still serve their calls (values are not lost);
  // but no new pull will happen, so #seal lets any call that would need one
  // settle done instead of hanging.
  #fail(slot, err) {
    slot.status = 'error';
    slot.error = err;
    this.#seal();
    this.#pump();
    this.#drainDone();
  }

  // Once we will pull no more (an error or return()), no value can exist past
  // the current slot window: freeze the boundary there so calls that would need
  // a new pull settle done. #upper already counts exactly those slots, so no
  // adjustment is needed. A clean done sets a tighter boundary itself, so only
  // seal when none is set yet.
  #seal() {
    if (this.#boundary === null) {
      this.#boundary = this.#slots.length;
    }
  }

  #slotIndex(slot) {
    return this.#slots.indexOf(slot);
  }

  #settleHeadSlot() {
    this.#discardHeadSlot(true);
    for (const c of this.#consumers) c.position--;
  }

  #discardHeadSlot(countedValue) {
    this.#slots.shift();
    if (countedValue) this.#upper--;
    if (this.#boundary !== null) this.#boundary--;
  }

  #close() {
    try {
      // errors from .return() are swallowed, as in IteratorClose
      Promise.resolve(this.#it?.return()).then(undefined, () => {});
    } catch {}
  }
}

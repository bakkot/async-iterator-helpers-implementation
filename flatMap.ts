export function flatMap(it: unknown, fn: unknown) {
  return new FlatMapHelper(it, fn);
}

function ASSERT(condition: boolean, message: string) {
  if (!condition) {
    console.error('assert failed: ' + message, (new Error).stack);
    setTimeout(() => {
      throw new Error('an assertion failed, see stderr');
    }, 0); // do in a timeout so nothing can swallow it
  }
}

function fastPromiseTry<T>(cb: () => T): Promise<Awaited<T>> {
  try {
    return Promise.resolve(cb());
  } catch (e) {
    return Promise.reject(e);
  }
}

type Slot =
  | { type: 'awaiting' }
  | { type: 'value', value: unknown }
  | ErrorState
  | { type: 'removed' }

// The active inner iterator. Its in-flight values live as the last entry of
// #innerIterators (not here), so that when it stops being active we don't have to
// move anything — the entry simply becomes a closed one.
type ActiveIter = { type: 'iter', iter: unknown }

// For errors from the mapper or from result iterators, we invoke .return() on
// whatever is still open (the underlying, and possibly an active inner iterator).
// Those calls must settle before the error is surfaced.
type ErrorState =
  | { type: 'error', error: unknown, closeState: 'ready', reject?: null }
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void) }

type ReadingUnderlyingState = { type: 'reading underlying', requested: number /* integer > 0 */ };

// return() landed while we were reading the underlying for the next inner iterator.
// We are committed to closing, so we will NOT pull the iterator that pull produces:
// the surplus bound demand was doned eagerly. One bound call is held — the position
// a pull/mapper rejection would land on. Nothing is closed eagerly: when the
// in-flight pull/mapper settles we close the iterator it produced (if any) and then
// the underlying, sequentially, and settle result.return() (resolveReturn) with the
// outcome of those closes. Draining always logically requests exactly one value —
// the held call, which is the last of #calls; the buffered parked values keep the
// calls before it. When parked slots truncate (an inner reports done), the freed
// calls are the LAST ones — the held position shifts earlier, since results deliver
// in call order and the rejection lands on the first call not bound to a surviving
// buffered value.
type DrainingState = {
  type: 'draining',
  resolveReturn: (v: unknown) => void,
};

type ActiveState =
  | { type: 'unstarted' }
  | ReadingUnderlyingState
  | DrainingState
  | ErrorState // specifically this means an error when reading from underlying or invoking the mapper
  | ActiveIter
  | { type: 'finished' } // but still might be outstanding earlier calls, to be settled by innerIterators


type Nextable = { next: () => unknown };
type MaybeReturnable = { return?: () => unknown };

class FlatMapHelper {
  #underlying: unknown;
  #fn: unknown;

  // The values arrays of inner iterators that still have values in flight, in queue
  // order. When #active is an iterator, the last entry is that (active) iterator's
  // values; every other entry belongs to a closed iterator. We hold only the values
  // arrays, not the iterators, so the iterators can be GC'd once closed.
  // invariant: the first entry is non-empty (so [0][0] is the head of the queue),
  // except transiently while the active iterator is the sole entry with no pulls yet.
  readonly #innerIterators: Slot[][] = [];

  #active: ActiveState = { type: 'unstarted' };

  // invariant: calls.length == [sum of lengths of innerIterators, which already
  // includes the active iterator's values when active is an iterator] + [active.requested
  // (reading underlying) | 1 (draining) | 0 (active is an iterator)]
  #calls: { resolve: (v: unknown) => void, reject: (v: unknown) => void }[] = [];

  constructor(underlying: unknown, fn: unknown) {
    this.#underlying = underlying;
    this.#fn = fn;
  }

  get #finished() {
    return this.#active.type === 'error' || this.#active.type === 'finished';
  }

  // total values buffered across all tracked inner iterators — including the active
  // one's, when active is an iterator (the first term of the #calls invariant)
  #bufferedValueCount() {
    return this.#innerIterators.reduce((acc, x) => acc + x.length, 0);
  }

  // the active iterator's values array (its in-flight pulls), which is the last entry
  get #activeValues(): Slot[] {
    ASSERT(this.#active.type === 'iter', 'active is iter');
    return this.#innerIterators[this.#innerIterators.length - 1];
  }

  // whether `values` is the active iterator's values array (the last entry, with an
  // active iterator). This is how we ask "is this iterator the active one".
  #isActiveValues(values: Slot[]): boolean {
    return this.#active.type === 'iter' && this.#innerIterators[this.#innerIterators.length - 1] === values;
  }

  #markSomeCallsAsNoLongerGettingValues(removedCount: number) {
    ASSERT(removedCount <= this.#calls.length, 'removedCount <= calls.length');
    const mightStillGetValues = this.#calls.length - removedCount;
    for (let i = 0; i < removedCount; ++i) {
      this.#calls[mightStillGetValues + i].resolve({ value: undefined, done: true });
    }
    this.#calls.length = mightStillGetValues;
  }

  #isHeadOfQueue(slot: Slot) {
    if (this.#innerIterators.length === 0) {
      // no buffered inner values; the only possible head is an active error
      return this.#active.type === 'error' && this.#active === slot;
    }
    return this.#innerIterators[0][0] === slot; // invariant: this.#innerIterators[0].length > 0
  }

  // Drop `values` (some inner iterator's values array) and everything after it, marking
  // the dropped slots removed. Leading empties exposed at the front of the queue are
  // popped by #processQueue, so this does not touch #innerIterators itself.
  #truncateInFlightFrom(values: Slot[], index: number) {
    ASSERT(index >= 0 && index < values.length, 'index in range');
    for (let i = index; i < values.length; ++i) {
      const slot = values[i];
      if (slot.type === 'value') {
        slot.value = null; // for memory reasons
      } else if (slot.type === 'error') {
        slot.error = null; // for memory reasons
      } else {
        ASSERT(slot.type === 'awaiting', 'slot awaiting');
      }
      slot.type = 'removed';
    }
    values.length = index;
  }

  #issuePullFromCurrentActive() {
    ASSERT(this.#active.type === 'iter', 'active is iter');

    const slot: Slot = { type: 'awaiting' } as Slot; // the cast is not a no-op
    const thisIterValues = this.#activeValues;
    thisIterValues.push(slot);

    const actualIter = (this.#active as ActiveIter).iter as Nextable;

    fastPromiseTry(() => actualIter.next()).then(
      iterResult => {
        // got iterator result from non-underlying iterator

        if (slot.type === 'removed') return;
        ASSERT(slot.type === 'awaiting', 'slot awaiting');

        if ((iterResult as { done: boolean }).done) {
          // Find the current index: earlier slots of this iterator may have been
          // delivered (and shifted off) since this pull was issued, so an index
          // captured at issue time would be stale.
          const currentIndex = thisIterValues.indexOf(slot);
          const removedCount = thisIterValues.length - currentIndex;
          ASSERT(removedCount > 0, 'have not already truncated this value');

          // Does removing these slots change the head of the queue (revealing
          // something that was buffered behind this iterator)? Only if this pull was
          // the head of its own iterator (currentIndex === 0) AND that iterator is the
          // front of the queue and not the active one — then truncation empties the
          // front entry, which #processQueue pops to expose the next entry. (Nothing is
          // buffered behind the active iterator, since it's always the last entry.)
          const exposedNewHead = currentIndex === 0 && this.#innerIterators[0] === thisIterValues && !this.#isActiveValues(thisIterValues);

          ASSERT(this.#innerIterators.includes(thisIterValues), 'this iterator is still tracked');

          this.#truncateInFlightFrom(thisIterValues, currentIndex);

          if (this.#isActiveValues(thisIterValues)) {
            // this iterator is still the active one; it just reported done. Its (now
            // possibly-empty) values stay in place as a soon-to-be-closed entry; drop
            // it only if empty, so we don't leave an empty entry behind.
            if (thisIterValues.length === 0) {
              this.#innerIterators.pop();
            }
            this.#issuePullFromUnderlying(removedCount);
          } else if (this.#active.type === 'iter') {
            // a parked iterator finished while a *different* iterator is active.
            // strictly speaking, if thisIterValues is now empty we could remove it
            // but, no real reason to; we'll pop when it gets to the head of the queue

            for (let i = 0; i < removedCount; ++i) {
              this.#issuePullFromCurrentActive();
            }
          } else if (this.#active.type === 'reading underlying') {
            // The freed demand is absorbed by the iterator the in-flight underlying
            // pull will produce.
            this.#active.requested += removedCount;
          } else if (this.#active.type === 'draining') {
            // We will NOT pull anything more, so these parked slots can never receive
            // a value: done their calls now. Results deliver in call order, so the
            // call held for the in-flight pull/mapper (the position a rejection would
            // land on) is the first one not bound to a surviving buffered value — the
            // freed calls are the LAST `removedCount`, shifting the held position
            // earlier. (Draining always logically requests exactly one held value.)
            this.#markSomeCallsAsNoLongerGettingValues(removedCount);
          } else {
            ASSERT(this.#active.type === 'error' || this.#active.type === 'finished', 'active is error or finished');

            this.#markSomeCallsAsNoLongerGettingValues(removedCount);
          }

          // If we popped the front of the queue, deliver from whatever it revealed.
          if (exposedNewHead) {
            this.#processQueue();
          }
        } else {
          // we got a value! amazing!
          const { value } = (iterResult as { value: unknown });
          slot.type = 'value';
          (slot as Extract<Slot, { type: 'value' }>).value = value;

          if (this.#isHeadOfQueue(slot)) {
            this.#processQueue();
          }
        }
      },
      error => {
        // got error from non-underlying iterator

        if (slot.type === 'removed') return;
        ASSERT(slot.type === 'awaiting', 'slot awaiting');
        slot.type = 'error';
        const slotButWithTypeScript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
        slotButWithTypeScript.error = error;
        slotButWithTypeScript.closeState = 'awaiting-return';

        if (this.#active.type === 'iter') {
          // The (formerly) active iterator's values are already the last entry of
          // #innerIterators; they stay there as a closed entry once we mark finished.
          const erroredIterIsActive = this.#isActiveValues(thisIterValues);
          const activeIter = (this.#active as ActiveIter).iter;
          this.#active = { type: 'finished' };

          if (erroredIterIsActive) {
            // just gotta close underlying
            this.#closeUnderlyingForError(slotButWithTypeScript as ErrorState);
          } else {
            // The errored slot lives in an iterator that already reported done (it's
            // parked in the queue); a *different* iterator (the active one) is still
            // live. Two things are open: the active iterator and the underlying. Close
            // them sequentially — the active inner iterator first, then the underlying,
            // matching the order return() uses — and surface the error only once both
            // closes have settled. Errors from either .return() are swallowed.
            //
            // The active iterator's already-requested pulls are NOT discarded: an error
            // stops new pulls, but values already in flight still deliver to their
            // calls, so it stays parked above (as an explicit return() would leave them).
            // Commit the call (if any) waiting on this slot before the closes settle,
            // so onClosed has a rejector to invoke; otherwise we mark it ready.
            if (this.#isHeadOfQueue(slot)) {
              this.#processQueue();
            }
            const onClosed = () => {
              // runs on either settlement of underlying.return(), swallowing its error
              if (slotButWithTypeScript.reject) {
                ASSERT((slot as Slot).type !== 'removed', 'slot not removed');
                slotButWithTypeScript.reject(error);
              } else {
                if ((slot as Slot).type === 'removed') return; // TODO make sure this is really what we want
                (slot as ErrorState).closeState = 'ready';
                ASSERT(!this.#isHeadOfQueue(slot), 'not head of queue');
              }
            };
            const closeUnderlying = () => {
              // runs on either settlement of activeIter.return(), swallowing its error
              fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.()).then(onClosed, onClosed);
            };
            fastPromiseTry(() => (activeIter as MaybeReturnable).return?.()).then(closeUnderlying, closeUnderlying);
          }
          return;
        }
        if (this.#active.type === 'reading underlying') {
          // TODO if we have already invoked #fn, the result might be an iterator, which we would need to close... which also means waiting for it...
          // also means distinguish 'reading underlying' vs 'waiting for mapper'
          // maybe we can make _the subsequent { done: true }_ wait??? it must exist b/c it was waiting for this value. need to think more / about other cases / effects on filter etc.

          // The errored slot belongs to a parked iterator; we were reading the
          // underlying for the NEXT iterator. That pending demand sits after the
          // error and was never bound to a pull, so it can never be filled: done it.
          this.#markSomeCallsAsNoLongerGettingValues(this.#active.requested);
          this.#active = { type: 'finished' };
          this.#closeUnderlyingForError(slotButWithTypeScript as ErrorState);
          return;
          // TODO do exceptions from the fn call at this point go into unhandled promise rejection
        }
        if (this.#active.type === 'draining') {
          // A parked iterator errored while we were draining the in-flight underlying
          // pull. Draining proceeds unaffected: the closes happen when that pull and
          // the mapper settle, and the held call remains the sink for a rejection
          // from them. This error just parks in order like any other; there is
          // nothing to close for it, since the closes are the draining flow's
          // responsibility.
          (slot as ErrorState).closeState = 'ready';
          if (this.#isHeadOfQueue(slot)) {
            this.#processQueue();
          }
          return;
        }
        ASSERT(this.#active.type === 'error' || this.#active.type === 'finished', 'active is error or finished');
        // nothing to close in this case
        (slot as ErrorState).closeState = 'ready';
        if (this.#isHeadOfQueue(slot)) {
          this.#processQueue();
        }
      },
    );
  }

  #markUnderlyingAsFinished() {
    ASSERT(this.#active.type === 'reading underlying' || this.#active.type === 'iter', 'active is reading underlying or iter'); // latter only via return()
    // When active is an iterator its values are already the last entry; they stay there
    // as a closed entry (drop it only if empty, so we don't leave an empty entry).
    if (this.#active.type === 'iter' && this.#activeValues.length === 0) {
      this.#innerIterators.pop();
    }
    this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#bufferedValueCount());
    this.#active = { type: 'finished' };
  }

  // The underlying produced a value while draining but we failed to map it (the
  // mapper threw or rejected, or obtaining the inner iterator threw). Like any
  // mapper error this closes the underlying — deferred until now — and the error
  // surfaces to the held call (the first call not bound to a buffered value) only
  // once that close settles. result.return() then settles from the close's outcome.
  #drainingErrorFromMapper(d: DrainingState, error: unknown) {
    ASSERT(this.#active === d, 'active is the draining state');
    const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
    this.#active = slot;
    // Commit the call (if this is the head) so the close reaction has a rejector;
    // otherwise it surfaces when it reaches the head.
    if (this.#isHeadOfQueue(slot)) {
      this.#processQueue();
    }
    const uClose = fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.());
    const onClosed = () => {
      // runs on either settlement of underlying.return(), swallowing its error
      const s = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
      if (s.reject) {
        s.reject(error);
      } else {
        (slot as ErrorState).closeState = 'ready';
        ASSERT(!this.#isHeadOfQueue(slot), 'not head of queue');
      }
    };
    uClose.then(onClosed, onClosed);
    // Registered after the rejection reaction above so the held call rejects before
    // result.return() settles; a failed close rejects result.return().
    d.resolveReturn(uClose.then(() => ({ value: undefined, done: true })));
  }

  // Close `inner` and then the underlying, sequentially — the inner's .return() must
  // settle before the underlying's is invoked. Resolves done unless a close failed,
  // in which case it rejects with that error, the inner close taking precedence
  // (though the underlying close still happens).
  #closeInnerThenUnderlying(inner: unknown) {
    // todo fast path for missing returns
    return fastPromiseTry(() => (inner as MaybeReturnable).return?.()).then(
      () => {
        // TODO strictly speaking we need to check for object-ness of the return value here
        // or, change the spec to never do that, because it's dumb
        return fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.())
          .then(() => ({ value: undefined, done: true }));
      },
      error => {
        // this error squashes errors from closing underlying
        return fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.())
          .finally(() => Promise.reject(error));
      },
    );
  }

  #issuePullFromUnderlying(requested: number) {
    ASSERT(this.#active.type === 'unstarted' || this.#active.type === 'iter', 'active is unstarted or iter'); // latter case is when we just got { done: true } from previous active
    this.#active = { type: 'reading underlying', requested };

    fastPromiseTry(() => (this.#underlying as Nextable).next()).then(
      r => {
        const active = this.#active;
        if (active.type !== 'reading underlying' && active.type !== 'draining') return;
        if ((r as { done: boolean }).done) {
          if (active.type === 'draining') {
            // The underlying exhausted itself before we could close it; a clean done
            // does not close the source, so there is nothing left to wait for.
            this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
            this.#active = { type: 'finished' };
            active.resolveReturn({ value: undefined, done: true });
          } else {
            this.#markUnderlyingAsFinished();
          }
          return;
        }

        // NB we don't await value; contract is non-promise here
        fastPromiseTry(() => (this.#fn as (r: unknown) => AsyncIterable<unknown>)((r as { value: unknown }).value)).then(
          iter => {
            const active = this.#active;
            if (active.type !== 'reading underlying' && active.type !== 'draining') return;

            // TODO handle sync iterators / iterables
            // TODO consider how to deal with distinguishing sync iterator from async iterator
            let actualIter: unknown;
            try {
              actualIter = iter[Symbol.asyncIterator]();
            } catch (error) {
              // Obtaining the inner iterator failed: treat it like a mapper throw.
              if (active.type === 'draining') {
                this.#drainingErrorFromMapper(active, error);
              } else {
                this.#closeUnderlyingForErrorInMapper(error);
              }
              return;
            }

            if (active.type === 'draining') {
              // We don't pull this iterator. Close it (it was never pulled, so it
              // cannot have finished on its own — no .return()-after-done hazard),
              // then the underlying, sequentially — the same as return() with an
              // active inner — and settle result.return() with that outcome.
              this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
              this.#active = { type: 'finished' };
              active.resolveReturn(this.#closeInnerThenUnderlying(actualIter));
              return;
            }

            const { requested } = active;
            this.#innerIterators.push([]); // this iterator's values; the active iterator is always the last entry
            this.#active = { type: 'iter', iter: actualIter };

            // ok, time to actually pull
            for (let i = 0; i < requested; ++i) {
              // TODO worry about re-entrancy from calling .next()/.return() - probably is OK, just gotta make sure state is set appropriately before invoking user code
              this.#issuePullFromCurrentActive();
            }
          },
          error => {
            const active = this.#active;
            if (active.type === 'draining') {
              this.#drainingErrorFromMapper(active, error);
              return;
            }
            if (active.type !== 'reading underlying') return;
            this.#closeUnderlyingForErrorInMapper(error);
          }
        );
      },
      error => {
        const active = this.#active;
        if (active.type !== 'reading underlying' && active.type !== 'draining') return;
        if (active.type === 'draining') {
          // The underlying errored after return(). It exhausted itself, so it is not
          // closed and result.return() has nothing to wait for; the error surfaces
          // to the held call immediately (after any buffered values).
          this.#active = { type: 'error', error, closeState: 'ready' };
          if (this.#innerIterators.length === 0) {
            this.#processQueue();
          }
          active.resolveReturn({ value: undefined, done: true });
          return;
        }

        // The underlying errored while fetching the next inner iterator. It is NOT
        // closed (it reported the error itself). Values buffered in already-parked
        // iterators still deliver ahead of the error; the error then goes to the
        // call at that position, and the rest of the coalesced demand is doned. We
        // keep the error live in #active so it surfaces only once those buffered
        // values have drained — overwriting it with a clean finish would swallow it.
        this.#active = { type: 'error', error, closeState: 'ready' };
        // keep one call per buffered value and one more for the error
        this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#bufferedValueCount() - 1);
        if (this.#innerIterators.length === 0) {
          this.#processQueue();
        }
        return;
      }
    );
  }

  #closeUnderlyingForErrorInMapper(error: unknown) {
    ASSERT(this.#active.type === 'reading underlying', 'active is reading underlying');
    const { requested } = this.#active as ReadingUnderlyingState;
    const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
    this.#markSomeCallsAsNoLongerGettingValues(requested - 1);
    this.#active = slot;
    this.#closeUnderlyingForError(slot);
  }

  #closeUnderlyingForError(slot: ErrorState) {
    ASSERT(slot.type === 'error', 'slot is error');
    ASSERT(slot.closeState === 'awaiting-return', 'slot awaiting-return');

    let returnPromise;
    try {
      returnPromise = (this.#underlying as MaybeReturnable).return?.();
    } catch {
      // synchronous throw from it.return() gets swallowed
    }
    if (returnPromise === undefined) {
      slot.closeState = 'ready';
      if (this.#isHeadOfQueue(slot)) {
        this.#processQueue();
      }
      return;
    }
    if (this.#isHeadOfQueue(slot)) {
      this.#processQueue();
    }
    const onClosed = () => {
      ASSERT(slot.closeState === 'awaiting-return', 'slot awaiting-return');
      const slotButWithTypeScript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
      if (slotButWithTypeScript.reject) {
        slotButWithTypeScript.reject(slot.error);
      } else {
        slot.closeState = 'ready';
        ASSERT(!this.#isHeadOfQueue(slot), 'not head of queue');
      }
    };
    // TODO fast path for non-promise?
    Promise.resolve(returnPromise).then(onClosed, onClosed);
  }

  // returns false if was awaiting
  #dispatchHeadOfInFlight(values: Slot[]): boolean {
    const head = values[0];
    if (head.type === 'awaiting') {
      return false;
    }
    values.shift();
    if (head.type === 'value') {
      this.#calls.shift()!.resolve({ value: head.value, done: false });
    } else if (head.type === 'error') {
      const call = this.#calls.shift()!;
      if (head.closeState === 'awaiting-return') {
        // This error triggered `.return()`, and the result has not yet settled.
        // Since this is the head of the queue, we can commit it to this call by leaving a rejector for
        // the close reaction to invoke, and can still drop `head` from the inFlight values.
        head.reject = call.reject;
      } else {
        ASSERT(head.closeState === 'ready', 'closeState ready');
        call.reject(head.error);
      }
    } else {
      // unreachable
      console.error('unreachable');
      throw new Error('unreachable');
    }
    return true;
  }

  #processQueue() {
    // assert: we are going to do at least one unit of work
    while (this.#innerIterators.length > 0) {
      const head = this.#innerIterators[0];
      while (head.length > 0) {
        if (!this.#dispatchHeadOfInFlight(head)) {
          return;
        }
      }
      // `head` is now empty. If it's the active iterator (always the last entry), leave
      // it in place to receive future pulls; otherwise drop the drained closed entry.
      if (this.#isActiveValues(head)) {
        return;
      }
      this.#innerIterators.shift();
    }
    if (this.#active.type === 'error') {
      if (this.#active.closeState === 'ready') {
        this.#calls.shift()!.reject(this.#active.error);
      } else {
        this.#active.reject = this.#calls.shift()!.reject;
      }
      this.#active = { type: 'finished' };
      // TODO maybe errors just go as a length-1 entry on top of innerIterators?
      return;
    }
  }

  next() {
    if (this.#finished || this.#active.type === 'draining') {
      return Promise.resolve({ value: undefined, done: true });
    }
    const { resolve, reject, promise } = Promise.withResolvers();
    this.#calls.push({ resolve, reject });
    if (this.#active.type === 'unstarted') {
      this.#issuePullFromUnderlying(1);
    } else if (this.#active.type === 'reading underlying') {
      ++this.#active.requested;
    } else {
      ASSERT(this.#active.type === 'iter', 'active is iter');
      // cannot be error because we guarded on this.#finished above
      this.#issuePullFromCurrentActive();
    }
    return promise;
  }

  return() {
    if (this.#active.type === 'unstarted') {
      // Nothing has been pulled yet, but — as in map and filter — return() still
      // closes the underlying. (No outstanding calls exist: the first next() would
      // have moved us out of 'unstarted'.)
      this.#active = { type: 'finished' };
      return fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.())
        .then(() => ({ value: undefined, done: true }));
    }
    if (this.#finished || this.#active.type === 'draining') {
      return Promise.resolve({ value: undefined, done: true });
    }

    if (this.#active.type === 'reading underlying') {
      // A pull from the underlying is in flight (possibly with the mapper also
      // pending). We're committed to closing, so we will NOT pull whatever iterator
      // that pull produces. The bound demand can't receive a value, so done the
      // trailing surplus eagerly and HOLD the head-most bound call (the position a
      // pull/mapper rejection would land on). Nothing is closed yet: when the
      // pull/mapper settle we close the iterator they produced (if any) and then
      // the underlying, and the promise returned here settles with that outcome.
      this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#bufferedValueCount() - 1);
      const { resolve, promise } = Promise.withResolvers();
      this.#active = { type: 'draining', resolveReturn: resolve };
      return promise;
    }

    // active is an inner iterator. Park it (its in-flight pulls keep delivering),
    // then close it and the underlying in sequence — active iterator first.
    // TODO order of truncation vs resolving this Promise
    const activeIter = (this.#active as ActiveIter).iter;
    this.#markUnderlyingAsFinished();
    return this.#closeInnerThenUnderlying(activeIter);
  }
}

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

// `finishedOnOwn` records that this iterator reported done/error from one of its
// own pulls — so we must never call .return() on it (it's already exhausted).
type InFlight = { type: 'iter', iter: unknown, readonly values: Slot[], finishedOnOwn?: boolean }

// For errors from the mapper or from result iterators, we invoke .return() on
// whatever is still open (the underlying, and possibly an active inner iterator).
// Those calls must settle before the error is surfaced.
type ErrorState =
  | { type: 'error', error: unknown, closeState: 'ready', reject?: null }
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void) }

type ReadingUnderlyingState = { type: 'reading underlying', requested: number /* integer > 0 */ };

// return() landed while we were reading the underlying for the next inner iterator.
// We've closed the underlying and resolved return() done, but the `requested` units
// of demand bound to the still-in-flight underlying pull are NOT abandoned: when
// that pull resolves we still map it, pull the resulting iterator `requested` times,
// deliver those values to the outstanding calls, then close the iterator. Behaves
// like 'reading underlying' for demand bookkeeping, but never pulls the underlying
// again (it's already closed).
type DrainingState = { type: 'draining', requested: number /* integer > 0 */ };

type ActiveState =
  | { type: 'unstarted' }
  | ReadingUnderlyingState
  | DrainingState
  | ErrorState // specifically this means an error when reading from underlying or invoking the mapper
  | InFlight
  | { type: 'finished' } // but still might be outstanding earlier calls, to be settled by closedButStillHaveValuesInFlight


type Nextable = { next: () => unknown };
type MaybeReturnable = { return?: () => unknown };

class FlatMapHelper {
  #underlying: unknown;
  #fn: unknown;

  // holds the .values arrays of closed iterators (not the InFlight objects, so the iterators themselves can be GC'd)
  // invariant: index [0] is non-empty
  readonly #closedButStillHaveValuesInFlight: Slot[][] = [];

  #active: ActiveState = { type: 'unstarted' };

  // invariant: calls.length == [sum of lengths of closedButStillHaveValuesInFlight] + [active.requested | active.values.length]
  #calls: { resolve: (v: unknown) => void, reject: (v: unknown) => void }[] = [];

  constructor(underlying: unknown, fn: unknown) {
    this.#underlying = underlying;
    this.#fn = fn;
  }

  get #finished() {
    return this.#active.type === 'error' || this.#active.type === 'finished';
  }

  // total values buffered in closed iterators (the first term of the #calls invariant)
  #bufferedValueCount() {
    return this.#closedButStillHaveValuesInFlight.reduce((acc, x) => acc + x.length, 0);
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
    return this.#closedButStillHaveValuesInFlight.length === 0
      ? this.#active.type === 'iter' && this.#active.values.length > 0 && this.#active.values[0] === slot // TODO think about whether this.#active.values can ever be empty
        ||this.#active.type === 'error' && this.#active === slot
      : this.#closedButStillHaveValuesInFlight[0][0] === slot; // assert: this.#closedButStillHaveValuesInFlight[0].length > 0
  }

  #truncateInFlightFrom(inFlight: InFlight, index: number) {
    ASSERT(index >= 0 && index < inFlight.values.length, 'index in range');
    for (let i = index; i < inFlight.values.length; ++i) {
      const slot = inFlight.values[i];
      if (slot.type === 'value') {
        slot.value = null; // for memory reasons
      } else if (slot.type === 'error') {
        slot.error = null; // for memory reasons
      } else {
        ASSERT(slot.type === 'awaiting', 'slot awaiting');
      }
      slot.type = 'removed';
    }
    inFlight.values.length = index;
    if (index === 0) {
      if (this.#closedButStillHaveValuesInFlight.length > 0 && this.#closedButStillHaveValuesInFlight[0] === inFlight.values) {
        do {
          this.#closedButStillHaveValuesInFlight.shift();
        } while (this.#closedButStillHaveValuesInFlight.length > 0 && this.#closedButStillHaveValuesInFlight[0].length === 0);
      }
    }
  }

  #issuePullFromCurrentActive() {
    ASSERT(this.#active.type === 'iter', 'active is iter');

    const slot: Slot = { type: 'awaiting' } as Slot; // the cast is not a no-op
    const inFlight = this.#active as InFlight;
    const thisIterValues = inFlight.values;
    thisIterValues.push(slot);

    const actualIter = inFlight.iter as Nextable;

    fastPromiseTry(() => actualIter.next()).then(
      iterResult => {
        // got iterator result from non-underlying iterator

        if (slot.type === 'removed') return;
        ASSERT(slot.type === 'awaiting', 'slot awaiting');

        if ((iterResult as { done: boolean }).done) {
          inFlight.finishedOnOwn = true; // exhausted itself — never .return() it
          // Find the current index: earlier slots of this iterator may have been
          // delivered (and shifted off) since this pull was issued, so an index
          // captured at issue time would be stale.
          const currentIndex = thisIterValues.indexOf(slot);
          const removedCount = thisIterValues.length - currentIndex;
          ASSERT(removedCount > 0, 'have not already truncated this value');

          // Does removing these slots change the head of the queue (revealing
          // something that was buffered behind this iterator)? Only if this pull was
          // the head of its own iterator (currentIndex === 0) AND that iterator is
          // the front of the closed queue — then truncation pops it and the next
          // entry becomes the head. (While `inFlight` is still the active iterator it
          // isn't in the closed queue, so this is false; and nothing is buffered
          // behind the active iterator anyway.) Capture before truncating pops it.
          const exposedNewHead = currentIndex === 0 && this.#closedButStillHaveValuesInFlight[0] === inFlight.values;

          ASSERT(this.#closedButStillHaveValuesInFlight.includes(inFlight.values) || this.#active === inFlight, 'inFlight is still tracked');

          this.#truncateInFlightFrom(inFlight, currentIndex);

          if (this.#active.type === 'iter') {
            if (this.#active === inFlight) {
              if (thisIterValues.length > 0) {
                this.#closedButStillHaveValuesInFlight.push(this.#active.values);
              }
              this.#issuePullFromUnderlying(removedCount);
            } else {
              // strictly speaking, if thisIterValues is now empty we could remove it
              // but, no real reason to; we'll pop when it gets to the head of the queue

              for (let i = 0; i < removedCount; ++i) {
                this.#issuePullFromCurrentActive();
              }
            }
          } else if (this.#active.type === 'reading underlying' || this.#active.type === 'draining') {
            // The freed demand is absorbed by the iterator the in-flight underlying
            // pull will produce. (While draining we won't pull the underlying again,
            // but we still pull that produced iterator `requested` times before
            // closing it, so the freed demand rolls onto it just the same.)
            this.#active.requested += removedCount;
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
        inFlight.finishedOnOwn = true; // exhausted itself (by erroring) — never .return() it
        slot.type = 'error';
        const slotButWithTypeScript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
        slotButWithTypeScript.error = error;
        slotButWithTypeScript.closeState = 'awaiting-return';

        if (this.#active.type === 'iter') {
          const active = this.#active;
          this.#closedButStillHaveValuesInFlight.push(active.values);
          this.#active = { type: 'finished' };

          if (active === inFlight) {
            // just gotta close underlying
            this.#closeUnderlyingForError(slotButWithTypeScript as ErrorState);
          } else {
            // The errored slot lives in an iterator that already reported done (it's
            // parked in the closed queue); a *different* iterator (`active`) is still
            // live. Two things are open: `active` and the underlying. Close them
            // sequentially — the active inner iterator first, then the underlying,
            // matching the order return() uses — and surface the error only once both
            // closes have settled. Errors from either .return() are swallowed.
            //
            // `active`'s already-requested pulls are NOT discarded: an error stops new
            // pulls, but values already in flight still deliver to their calls, so
            // `active` stays parked above (as an explicit return() would leave them).
            const activeIter = active.iter;
            slotButWithTypeScript.closeState = 'awaiting-return';
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
          // Same as the reading-underlying case, but after return(): a parked
          // iterator errored while we were draining the in-flight underlying pull.
          // The underlying is already closing, so we don't close it again; the bound
          // demand can never be filled now the stream is truncated here, so done it
          // (and the in-flight pull's result is discarded once we're finished). The
          // error itself still reaches the call at this slot's position.
          this.#markSomeCallsAsNoLongerGettingValues(this.#active.requested);
          this.#active = { type: 'finished' };
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
    if (this.#active.type === 'iter' && this.#active.values.length > 0) {
      this.#closedButStillHaveValuesInFlight.push(this.#active.values);
    }
    this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#bufferedValueCount());
    this.#active = { type: 'finished' };
  }

  // The in-flight underlying pull we were draining (after return()) produced no
  // usable inner iterator — it reported done, errored, or the mapper failed. The
  // `requested` units of demand bound to it can never be filled, so done them.
  // Values buffered in already-parked iterators (ahead in the queue) keep their
  // own calls and still deliver.
  #finishDraining() {
    ASSERT(this.#active.type === 'draining', 'active is draining');
    const { requested } = this.#active as DrainingState;
    this.#active = { type: 'finished' };
    this.#markSomeCallsAsNoLongerGettingValues(requested);
  }

  #issuePullFromUnderlying(requested: number) {
    ASSERT(this.#active.type === 'unstarted' || this.#active.type === 'iter', 'active is unstarted or iter'); // latter case is when we just got { done: true } from previous active
    this.#active = { type: 'reading underlying', requested };

    fastPromiseTry(() => (this.#underlying as Nextable).next()).then(
      r => {
        // We may be 'reading underlying' (live) or 'draining' (return() landed while
        // this pull was in flight). Anything else means the stream already ended via
        // another path, so this value is discarded.
        const st = this.#active.type;
        if (st !== 'reading underlying' && st !== 'draining') return;
        if ((r as { done: boolean }).done) {
          // Underlying exhausted. While draining the bound demand can never be
          // filled; otherwise this is the normal terminal done.
          if (st === 'draining') {
            this.#finishDraining();
          } else {
            this.#markUnderlyingAsFinished();
          }
          return;
        }

        // NB we don't await value; contract is non-promise here
        fastPromiseTry(() => (this.#fn as (r: unknown) => AsyncIterable<unknown>)((r as { value: unknown }).value)).then(
          iter => {
            const st = this.#active.type;
            if (st !== 'reading underlying' && st !== 'draining') return;
            const draining = st === 'draining';

            // TODO handle sync iterators / iterables
            // TODO consider how to deal with distinguishing sync iterator from async iterator
            let actualIter: unknown;
            try {
              actualIter = iter[Symbol.asyncIterator]();
            } catch (error) {
              // Obtaining the inner iterator failed. While draining the underlying
              // is already closing, so just abandon the bound demand; otherwise this
              // closes the underlying like a mapper throw.
              if (draining) {
                this.#finishDraining();
              } else {
                this.#closeUnderlyingForErrorInMapper(error);
              }
              return;
            }

            const { requested } = (this.#active as ReadingUnderlyingState | DrainingState);
            this.#active = { type: 'iter', iter: actualIter, values: [] };

            // ok, time to actually pull
            for (let i = 0; i < requested; ++i) {
              // TODO worry about re-entrancy from calling .next()/.return() - probably is OK, just gotta make sure state is set appropriately before invoking user code
              this.#issuePullFromCurrentActive();
            }

            if (draining) {
              // We only ever wanted these `requested` values out of this iterator.
              // Park it (its just-issued pulls keep delivering through the finished
              // machinery) and close it. markUnderlyingAsFinished dones nothing here:
              // the invariant guarantees calls.length - bufferedValueCount === the
              // `requested` slots we just parked.
              const innerInFlight = this.#active as InFlight;
              this.#markUnderlyingAsFinished();
              // DEFER the close one microtask and skip it if the iterator has by then
              // reported done/error on its own: flatMap only learns a pull's outcome
              // asynchronously, so closing synchronously could .return() an iterator a
              // (synchronously-resolved) done pull already finished. Closing a still-
              // live iterator while its pulls are in flight is fine — a later done is
              // recorded after this check, exactly as an ordinary return() leaves
              // already-requested pulls deliverable.
              Promise.resolve().then(() => {
                if (innerInFlight.finishedOnOwn) return;
                fastPromiseTry(() => (actualIter as MaybeReturnable).return?.()).then(() => {}, () => {});
              });
            }
          },
          error => {
            const st = this.#active.type;
            if (st !== 'reading underlying' && st !== 'draining') return;
            if (st === 'draining') {
              // Mapper rejected after return(): the underlying is already closing,
              // so just abandon the bound demand.
              this.#finishDraining();
              return;
            }
            this.#closeUnderlyingForErrorInMapper(error);
          }
        );
      },
      error => {
        const st = this.#active.type;
        if (st !== 'reading underlying' && st !== 'draining') return;
        if (st === 'draining') {
          // The underlying errored after return(); it's already closing, so swallow
          // the error and abandon the bound demand.
          this.#finishDraining();
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
        if (this.#closedButStillHaveValuesInFlight.length === 0) {
          this.#processQueue();
        }
        return;
      }
    );
  }

  #closeUnderlyingForErrorInMapper(error: unknown) {
    ASSERT(this.#active.type === 'reading underlying', 'active is reading underlying');
    const { requested } = this.#active as ReadingUnderlyingState;
    const slot = { type: 'error', error, closeState: 'awaiting-return', reject: null } as const;
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
    while (this.#closedButStillHaveValuesInFlight.length > 0) {
      const head = this.#closedButStillHaveValuesInFlight[0];
      while (head.length > 0) {
        if (!this.#dispatchHeadOfInFlight(head)) {
          return;
        }
      }
      this.#closedButStillHaveValuesInFlight.shift();
    }
    if (this.#active.type === 'error') {
      if (this.#active.closeState === 'ready') {
        this.#calls.shift()!.reject(this.#active.error);
      } else {
        this.#active.reject = this.#calls.shift()!.reject;
      }
      this.#active = { type: 'finished' };
      // TODO maybe errors just go as a length-1 entry on top of closedButStillHaveValuesInFlight?
      return;
    }
    if (this.#active.type === 'iter') {
      while (this.#active.values.length > 0) {
        if (!this.#dispatchHeadOfInFlight(this.#active.values)) {
          return;
        }
      }
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
      // pending). Close the underlying and resolve done now, but DON'T abandon the
      // demand bound to that pull: switch to 'draining' so that when the pull
      // resolves we still map it, pull the produced iterator for the bound demand,
      // deliver those values, then close it.
      this.#active = { type: 'draining', requested: this.#active.requested };
      return fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.())
        .then(() => ({ value: undefined, done: true }));
    }

    // active is an inner iterator. Park it (its in-flight pulls keep delivering),
    // then close it and the underlying in sequence — active iterator first.
    // TODO order of truncation vs resolving this Promise
    const active = this.#active;
    this.#markUnderlyingAsFinished();
    const activeIter = active.iter;

    // todo fast path for missing returns
    return fastPromiseTry(() => (activeIter as MaybeReturnable).return?.()).then(
      () => {
        // TODO strictly speaking we need to check for object-ness of the return value here
        // or, change the spec to never do that, because it's dumb
        return fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.())
          .then(() => ({ value: undefined, done: true }))
      },
      error => {
        // this error squashes errors from closing underlying
        return fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.())
          .finally(() => Promise.reject(error));
      },
    );
  }
}

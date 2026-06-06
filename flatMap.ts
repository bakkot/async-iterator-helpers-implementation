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
  | Error
  | { type: 'removed' }

type InFlight = { type: 'iter', iter: unknown, readonly values: Slot[] }

// For errors from the mapper or from result iterators, we invoke .return() on
// whatever is still open (the underlying, and possibly an active inner iterator).
// Those calls must settle before the error is surfaced.
type Error =
  | { type: 'error', error: unknown, closeState: 'ready', reject?: null }
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void) }

type ReadingUnderlyingState = { type: 'reading underlying', requested: number /* integer > 0 */ };

type ActiveState =
  | { type: 'unstarted' }
  | ReadingUnderlyingState
  | Error // specifically this means an error when reading from underlying or invoking the mapper
  | InFlight
  | { type: 'finished' } // but still might be outstanding earlier calls, to be settled by closedButStillHaveValuesInFlight


type Nextable = { next: () => unknown };
type MaybeReturnable = { return?: () => unknown };

class FlatMapHelper {
  #underlying: unknown;
  #fn: unknown;

  // TODO this should just be the .values, so we don't prevent the iterators from being GC'd
  // invariant: index [0] is non-empty
  readonly #closedButStillHaveValuesInFlight: InFlight[] = [];

  #active: ActiveState = { type: 'unstarted' };

  // we need this to tell us how many trailing { done: true }s to issue in case of error / finish in active iterator
  // invariant: calls.length == maxLive + [active.requested | active.values.length]
  // is this just the sum of the lengths of the values array?
  // #maxLiveInClosedButStillHaveValuesInFlight = 0; // 0 iff #closedButStillHaveValuesInFlight.length === 0

  #calls: { resolve: (v: unknown) => void, reject: (v: unknown) => void }[] = [];

  constructor(underlying: unknown, fn: unknown) {
    this.#underlying = underlying;
    this.#fn = fn;
  }

  get #finished() {
    return this.#active.type === 'error' || this.#active.type === 'finished';
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
      : this.#closedButStillHaveValuesInFlight[0].values[0] === slot; // assert: this.#closedButStillHaveValuesInFlight[0].values.length > 0
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
      if (this.#closedButStillHaveValuesInFlight.length > 0 && this.#closedButStillHaveValuesInFlight[0] === inFlight) {
        do {
          this.#closedButStillHaveValuesInFlight.shift();
        } while (this.#closedButStillHaveValuesInFlight.length > 0 && this.#closedButStillHaveValuesInFlight[0].values.length === 0);
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
          const exposedNewHead = currentIndex === 0 && this.#closedButStillHaveValuesInFlight[0] === inFlight;

          ASSERT(this.#closedButStillHaveValuesInFlight.includes(inFlight) || this.#active === inFlight, 'inFlight is still tracked');

          this.#truncateInFlightFrom(inFlight, currentIndex);

          if (this.#active.type === 'iter') {
            if (this.#active === inFlight) {
              if (thisIterValues.length > 0) {
                this.#closedButStillHaveValuesInFlight.push(this.#active);
              }
              this.#issuePullFromUnderlying(removedCount);
            } else {
              // strictly speaking, if thisIterValues is now empty we could remove it
              // but, no real reason to; we'll pop when it gets to the head of the queue

              for (let i = 0; i < removedCount; ++i) {
                this.#issuePullFromCurrentActive();
              }
            }
          } else if (this.#active.type === 'reading underlying') {
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
        slot.type = 'error';
        const slotButWithTypeScript = slot as Extract<Error, { closeState: 'awaiting-return' }>;
        slotButWithTypeScript.error = error;
        slotButWithTypeScript.closeState = 'awaiting-return';

        if (this.#active.type === 'iter') {
          const active = this.#active;
          this.#closedButStillHaveValuesInFlight.push(this.#active);
          this.#active = { type: 'finished' };

          if (active === inFlight) {
            // just gotta close underlying
            this.#closeUnderlyingForError(slotButWithTypeScript as Error);
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
                (slot as Error).closeState = 'ready';
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
          this.#closeUnderlyingForError(slotButWithTypeScript as Error);
          return;
          // TODO do exceptions from the fn call at this point go into unhandled promise rejection
        }
        ASSERT(this.#active.type === 'error' || this.#active.type === 'finished', 'active is error or finished');
        // nothing to close in this case
        (slot as Error).closeState = 'ready';
        if (this.#isHeadOfQueue(slot)) {
          this.#processQueue();
        }
      },
    );
  }

  #markUnderlyingAsFinished() {
    ASSERT(this.#active.type === 'reading underlying' || this.#active.type === 'iter', 'active is reading underlying or iter'); // latter only via return()
    if (this.#active.type === 'iter' && this.#active.values.length > 0) {
      this.#closedButStillHaveValuesInFlight.push(this.#active);
    }
    const maxLive = this.#closedButStillHaveValuesInFlight.reduce((acc, x) => acc + x.values.length, 0);
    this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - maxLive);
    this.#active = { type: 'finished' };
  }

  #issuePullFromUnderlying(requested: number) {
    ASSERT(this.#active.type === 'unstarted' || this.#active.type === 'iter', 'active is unstarted or iter'); // latter case is when we just got { done: true } from previous active
    this.#active = { type: 'reading underlying', requested };

    fastPromiseTry(() => (this.#underlying as Nextable).next()).then(
      r => {
        if (this.#finished) return;
        ASSERT(this.#active.type === 'reading underlying', 'active is reading underlying');
        if ((r as { done: boolean }).done) {
          this.#markUnderlyingAsFinished();
          return;
        }

        // NB we don't await value; contract is non-promise here
        fastPromiseTry(() => (this.#fn as (r: unknown) => AsyncIterable<unknown>)((r as { value: unknown }).value)).then(
          iter => {
            if (this.#finished) return;
            ASSERT(this.#active.type === 'reading underlying', 'active is reading underlying');

            // TODO handle sync iterators / iterables
            // TODO consider how to deal with distinguishing sync iterator from async iterator
            try {
              const actualIter = iter[Symbol.asyncIterator]();

              const { requested } = (this.#active as ReadingUnderlyingState);
              this.#active = { type: 'iter', iter: actualIter, values: [] };

              // ok, time to actually pull
              for (let i = 0; i < requested; ++i) {
                // TODO worry about re-entrancy from calling .next()/.return() - probably is OK, just gotta make sure state is set appropriately before invoking user code
                this.#issuePullFromCurrentActive();
              }
            } catch (error) {
              this.#closeUnderlyingForErrorInMapper(error);
            }
          },
          error => {
            if (this.#finished) return;
            ASSERT(this.#active.type === 'reading underlying', 'active is reading underlying');
            this.#closeUnderlyingForErrorInMapper(error);
          }
        );
      },
      error => {
        if (this.#finished) return;
        ASSERT(this.#active.type === 'reading underlying', 'active is reading underlying');

        // The underlying errored while fetching the next inner iterator. It is NOT
        // closed (it reported the error itself). Values buffered in already-parked
        // iterators still deliver ahead of the error; the error then goes to the
        // call at that position, and the rest of the coalesced demand is doned. We
        // keep the error live in #active so it surfaces only once those buffered
        // values have drained — overwriting it with a clean finish would swallow it.
        this.#active = { type: 'error', error, closeState: 'ready' };
        const maxLive = this.#closedButStillHaveValuesInFlight.reduce((acc, x) => acc + x.values.length, 0);
        // keep maxLive calls for the buffered values and one more for the error
        this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - maxLive - 1);
        if (this.#closedButStillHaveValuesInFlight.length === 0) {
          this.#processQueue();
        }
        return;
      }
    );
  }

  #closeUnderlyingForErrorInMapper(error: unknown) {
    ASSERT(this.#active.type === 'reading underlying', 'active is reading underlying');
    const requested = this.#active.type === 'reading underlying' ? this.#active.requested : 1;
    const slot = { type: 'error', error, closeState: 'awaiting-return', reject: null } as const;
    this.#markSomeCallsAsNoLongerGettingValues(requested - 1);
    this.#active = slot;
    this.#closeUnderlyingForError(slot);
  }

  #closeUnderlyingForError(slot: Error) {
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
      const slotButWithTypeScript = slot as Extract<Error, { closeState: 'awaiting-return' }>;
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
  #dispatchHeadOfInFlight(inFlight: InFlight): boolean {
    const head = inFlight.values[0];
    if (head.type === 'awaiting') {
      return false;
    }
    inFlight.values.shift();
    if (head.type === 'value') {
      this.#calls.shift()!.resolve({ value: head.value, done: false });
    } else if (head.type === 'error') {
      const call = this.#calls.shift()!;
      if (head.closeState === 'awaiting-return') {
        // This error triggered `.return()`, and the result has not yet settled.
        // Since this is the head of the queue, we can commit it to this call by leaving a rejector for
        // the close reaction to invoke, and can still drop `headHead` from the inFlight values.
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
      while (head.values.length > 0) {
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
        if (!this.#dispatchHeadOfInFlight(this.#active)) {
          return;
        }
      }
    }
  }

  next() {
    if (this.#finished) {
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
      this.#active = { type: 'finished' };
    }
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    // TODO order of truncation vs resolving this Promise
    // Capture #active before #markUnderlyingAsFinished resets it to 'finished'.
    const active = this.#active;
    this.#markUnderlyingAsFinished();

    if (active.type === 'iter') {
      // TODO consider whether to block on closing active before closing underlying
      // probably yes?
      // TODO make this match above
      // TODO check against iterator sync flatmap
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

    ASSERT(active.type === 'reading underlying', 'active is reading underlying');
    // TODO if we're actually blocked on the mapper here, we probably need to handle closing the result
    return fastPromiseTry(() => (this.#underlying as MaybeReturnable).return?.())
      .then(() => ({ value: undefined, done: true }));
  }
}

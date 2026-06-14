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

type InFlight = { type: 'iter', iter: unknown, readonly values: Slot[] }

// For errors from the mapper or from result iterators, we invoke .return() on
// whatever is still open (the underlying, and possibly an active inner iterator).
// Those calls must settle before the error is surfaced.
type ErrorState =
  | { type: 'error', error: unknown, closeState: 'ready', reject?: null }
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void) }

type ReadingUnderlyingState = { type: 'reading underlying', requested: number /* integer > 0 */ };

// draining = we must wait for an in-flight underlying pull (and the mapper) to
// finish handing us the inner iterator so we can close it, then close the
// underlying, before we are done. Two triggers:
//   * resolveReturn set: result.return() was called while pulling or mapping;
//     the held .return() promise settles from the close outcome.
//   * errorSlot set: an *earlier* inner iterator errored while we were already
//     reading the underlying for the next one. There is no result.return(); the
//     held position is the error slot, whose error surfaces once the closes settle.
type DrainingState =
| {
    type: 'draining',
    resolveReturn: ((v: unknown) => void),
    errorSlot: null,
  }
| {
    type: 'draining',
    resolveReturn: null,
    errorSlot: ErrorState,
  };

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

  // invariant: calls.length == [sum of lengths of closedButStillHaveValuesInFlight] + [active.requested | active.values.length | (1 when draining)]
  #calls: { resolve: (v: unknown) => void, reject: (v: unknown) => void }[] = [];

  constructor(underlying: unknown, fn: unknown) {
    this.#underlying = underlying;
    this.#fn = fn;
  }

  #valuesWeCouldDeliverFromClosedInnerIterators() {
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
      ? this.#active.type === 'iter' && this.#active.values[0] === slot
        || this.#active.type === 'error' && this.#active === slot
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
        // got iterator result from inner iterator

        if (slot.type === 'removed') return;
        ASSERT(slot.type === 'awaiting', 'slot awaiting');

        if ((iterResult as { done: boolean }).done) {
          // I am assuming this can be done cheaply, possibly with a slightly different data structure
          // though also in practice N is small enough for it not to matter
          const currentIndex = thisIterValues.indexOf(slot);
          const removedCount = thisIterValues.length - currentIndex;
          ASSERT(removedCount > 0, 'have not already truncated this value');

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
          } else if (this.#active.type === 'reading underlying') {
            this.#active.requested += removedCount;
          } else {
            ASSERT(this.#active.type === 'error' || this.#active.type === 'draining' || this.#active.type === 'finished', 'no longer issuing pulls');

            this.#markSomeCallsAsNoLongerGettingValues(removedCount);
          }

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
        // got error from inner iterator

        if (slot.type === 'removed') return;
        ASSERT(slot.type === 'awaiting', 'slot awaiting');
        slot.type = 'error';
        const slotButWithTypeScript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
        slotButWithTypeScript.error = error;

        if (this.#active.type === 'iter') {
          slotButWithTypeScript.closeState = 'awaiting-return';
          const active = this.#active;
          this.#closedButStillHaveValuesInFlight.push(active.values);
          this.#active = { type: 'finished' };

          if (active === inFlight) {
            // just gotta close underlying
            // this will also call processQueue if necessary
            this.#closeUnderlyingForError(slotButWithTypeScript as ErrorState);
          } else {
            // gotta close both underlying and active
            const activeIter = active.iter;
            if (this.#isHeadOfQueue(slot)) {
              this.#processQueue();
            }

            const onClosed = () => {
              if (slotButWithTypeScript.reject) {
                ASSERT((slot as Slot).type !== 'removed', 'slot not removed');
                slotButWithTypeScript.reject(error);
              } else {
                if ((slot as Slot).type === 'removed') return; // TODO make sure this is really what we want
                (slot as ErrorState).closeState = 'ready';
                ASSERT(!this.#isHeadOfQueue(slot), 'not head of queue');
              }
            };
            this.#closeInnerThenUnderlying(activeIter as MaybeReturnable, onClosed);
          }
          return;
        }
        if (this.#active.type === 'reading underlying') {
          slotButWithTypeScript.closeState = 'awaiting-return';
          this.#markSomeCallsAsNoLongerGettingValues(this.#active.requested);
          this.#active = { type: 'draining', resolveReturn: null, errorSlot: slotButWithTypeScript };
          if (this.#isHeadOfQueue(slot)) {
            this.#processQueue();
          }
          return;
        }
        ASSERT(this.#active.type === 'error' || this.#active.type === 'draining' || this.#active.type === 'finished', 'no longer issuing pulls');
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
    this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#valuesWeCouldDeliverFromClosedInnerIterators());
    this.#active = { type: 'finished' };
  }

  // The underlying produced a value while draining but we failed to map it (the
  // mapper threw or rejected, or obtaining the inner iterator threw). Like any
  // mapper error this closes the underlying — deferred until now — and the error
  // surfaces to the held call (the first call not bound to a buffered value) only
  // once that close settles. result.return() then settles from the close's outcome.
  #drainingErrorFromMapper(d: DrainingState, error: unknown) {
    ASSERT(this.#active === d, 'active is the draining state');
    ASSERT(d.resolveReturn != null, 'draining-from-return, not draining-from-error');
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
    d.resolveReturn!(uClose.then(() => ({ value: undefined, done: true })));
  }

  // we were holding this error until some event finished, and it now has
  #commitError(slot: ErrorState) {
    ASSERT(slot.closeState === 'awaiting-return', 'error was pending');
    const s = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
    if (s.reject) {
      s.reject(slot.error);
    } else {
      (slot as ErrorState).closeState = 'ready';
      if (this.#isHeadOfQueue(slot)) {
        this.#processQueue();
      }
    }
  }

  #closeInnerThenUnderlying(inner: MaybeReturnable, next: (gotError: boolean, error?: unknown) => void) {
    this.#closeIterThen(inner, (gotError, error) => {
      this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError2, error2) => {
        if (gotError) {
          next(true, error);
        } else if (gotError2) {
          next(true, error2);
        } else {
          next(false);
        }
      });
    });
  }

  #issuePullFromUnderlying(requested: number) {
    ASSERT(this.#active.type === 'unstarted' || this.#active.type === 'iter', 'active is unstarted or iter'); // latter case is when we just got { done: true } from previous active
    this.#active = { type: 'reading underlying', requested };

    fastPromiseTry(() => (this.#underlying as Nextable).next()).then(
      r => {
        // successfully pulled underlying
        const active = this.#active;
        ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
        if ((r as { done: boolean }).done) {
          if (active.type === 'draining') {
            // if underlying was exhausted while we were waiting for it to close, the things which were waiting for it can just proceed
            this.#active = { type: 'finished' };
            if (active.errorSlot) {
              this.#commitError(active.errorSlot);
            } else {
              this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
              active.resolveReturn({ value: undefined, done: true });
            }
          } else {
            this.#markUnderlyingAsFinished();
          }
          return;
        }

        // NB we don't await value; contract is non-promise here
        fastPromiseTry(() => (this.#fn as (r: unknown) => AsyncIterable<unknown>)((r as { value: unknown }).value)).then(
          iter => {
            const active = this.#active;
            ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');

            // TODO handle sync iterators / iterables
            // TODO consider how to deal with distinguishing sync iterator from async iterator
            let actualIter: unknown;
            try {
              actualIter = iter[Symbol.asyncIterator]();
            } catch (error) {
              this.#gotErrorFromMapper(error);
              return;
            }

            if (active.type === 'draining') {
              // we just close, not pull
              this.#active = { type: 'finished' };
              if (active.errorSlot) {
                this.#closeInnerThenUnderlying(actualIter as MaybeReturnable, () => this.#commitError(active.errorSlot));
              } else {
                this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
                this.#closeInnerThenUnderlying(actualIter as MaybeReturnable, (gotError, error) => gotError ? active.resolveReturn(Promise.reject(error)) : active.resolveReturn({ done: true, value: undefined })); // TODO just store the rejector
              }
              return;
            }

            const { requested } = active as Extract<ActiveState, { type: 'reading underlying '}>;
            this.#active = { type: 'iter', iter: actualIter, values: [] };

            // ok, time to actually pull
            for (let i = 0; i < requested; ++i) {
              // TODO worry about re-entrancy from calling .next()/.return() - probably is OK, just gotta make sure state is set appropriately before invoking user code
              this.#issuePullFromCurrentActive();
            }
          },
          error => {
            this.#gotErrorFromMapper(error);
          }
        );
      },
      error => {
        // error from pulling underlying
        const active = this.#active;
        ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
        if (active.type === 'draining' && active.errorSlot) {
          this.#active = { type: 'finished' };
          this.#commitError(active.errorSlot);
          return;
        }

        if (active.type === 'reading underlying') {
          this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#valuesWeCouldDeliverFromClosedInnerIterators() - 1); // -1 for the error
        }

        if (this.#closedButStillHaveValuesInFlight.length === 0) {
          this.#calls.shift()!.reject(error);
          this.#active = { type: 'finished' };
        } else {
          this.#active = { type: 'error', error, closeState: 'ready' };
        }

        // TODO maybe move this above; it's just here for tick ordering reasons we probably don't care about
        if (active.type === 'draining') {
          active.resolveReturn({ value: undefined, done: true });
        }
        return;
      }
    );
  }

  #gotErrorFromMapper(error: unknown) {
    const active = this.#active;
    ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
    if (active.type === 'draining') {
      if (active.errorSlot) {
        this.#active = { type: 'finished' };
        this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError, error) => {
          this.#commitError(active.errorSlot)
        });
      } else {
        this.#drainingErrorFromMapper(active, error);
      }
      return;
    }
    const { requested } = this.#active as ReadingUnderlyingState;
    const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
    this.#markSomeCallsAsNoLongerGettingValues(requested - 1);
    this.#active = slot;
    this.#closeUnderlyingForError(slot);
  }

  #closeUnderlyingForError(slot: ErrorState) {
    ASSERT(slot.type === 'error', 'slot is error');
    ASSERT(slot.closeState === 'awaiting-return', 'slot awaiting-return');

    if (this.#isHeadOfQueue(slot)) {
      this.#processQueue();
    }

    this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError, error) => {
      // we don't actually care if calling return threw
      ASSERT(slot.closeState === 'awaiting-return', 'slot awaiting-return');
      const slotButWithTypeScript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
      if (slotButWithTypeScript.reject) {
        slotButWithTypeScript.reject(slot.error);
      } else {
        slot.closeState = 'ready';
        ASSERT(!this.#isHeadOfQueue(slot), 'not head of queue');
      }
    });
  }

  // this is very zalgo but whatever
  #closeIterThen(iter: MaybeReturnable, next: (gotError: boolean, error?: unknown) => void): void {
    let returnPromise;
    try {
      returnPromise = iter.return?.();
    } catch (error) {
      next(true, error);
      return;
    }
    // TODO fast path for non-promise in general?
    if (!returnPromise) {
      next(false);
    } else {
      Promise.resolve(returnPromise).then(() => next(false), e => next(true, e));
    }
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
        head.reject = call.reject;
      } else {
        ASSERT(head.closeState === 'ready', 'closeState ready');
        call.reject(head.error);
      }
    } else {
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
    if (this.#active.type === 'error' || this.#active.type === 'draining' || this.#active.type === 'finished') {
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
    if (this.#active.type === 'error' || this.#active.type === 'draining' || this.#active.type === 'finished') {
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
      this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#valuesWeCouldDeliverFromClosedInnerIterators() - 1);
      const { resolve, promise } = Promise.withResolvers();
      this.#active = { type: 'draining', resolveReturn: resolve, errorSlot: null };
      return promise;
    }

    // active is an inner iterator. Park it (its in-flight pulls keep delivering),
    // then close it and the underlying in sequence — active iterator first.
    // TODO order of truncation vs resolving this Promise
    const active = this.#active as InFlight;
    this.#markUnderlyingAsFinished();
    return new Promise((res, rej) => {
      this.#closeInnerThenUnderlying(active.iter as MaybeReturnable, (gotError, error) => gotError ? rej(error) : res({ done: true, value: undefined }));
    })
  }
}

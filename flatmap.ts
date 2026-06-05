export function flatMap(it: unknown, fn: unknown) {
  return new FlatMapHelper(it, fn);
}

function fastPromiseTry<T>(cb: () => T): Promise<Awaited<T>> {
  try {
    return Promise.resolve(cb());
  } catch (e) {
    return Promise.reject(e);
  }
}

declare global {
  interface Math {
    sumPrecise(numbers: Iterable<number>): number;
  }
}

type Slot =
  | { type: 'awaiting' }
  | { type: 'value', value: unknown }
  | ErrorWithPossiblyTwoCloses
  | { type: 'removed' }

type InFlight = { type: 'iter', iter: unknown, readonly values: Slot[] }

// For errors from the mapper or from result iterators, we invoke underlying.return()
// This call must settle before the error is surfaced.
type Error =
  | { type: 'error', error: unknown, closeState: 'ready', reject?: null }
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void), count: 1 }

type ErrorWithPossiblyTwoCloses =
  | Error
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void), count: 2 }

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
  #it: unknown;
  #fn: unknown;

  readonly #closedButStillHaveValuesInFlight: InFlight[] = [];

  #active: ActiveState = { type: 'unstarted' };

  // we need this to tell us how many trailing { done: true }s to issue in case of error / finish in active iterator
  // invariant: calls.length == maxLive + [active.requested | active.values.length]
  // is this just the sum of the lengths of the values array?
  // #maxLiveInClosedButStillHaveValuesInFlight = 0; // 0 iff #closedButStillHaveValuesInFlight.length === 0

  #calls: { resolve: (v: unknown) => void, reject: (v: unknown) => void }[] = [];

  constructor(it: unknown, fn: unknown) {
    this.#it = it;
    this.#fn = fn;
  }

  get #finished() {
    return this.#active.type === 'error' || this.#active.type === 'finished';
  }

  #markSomeCallsAsNoLongerGettingValues(removedCount: number) {
    // assert count < this.#calls.length
    const mightStillGetValues = this.#calls.length - removedCount;
    for (let i = 0; i < removedCount; ++i) {
      this.#calls[mightStillGetValues + i].resolve({ done: true, value: undefined });
    }
    this.#calls.length = mightStillGetValues;
  }

  #isHeadOfQueue(slot: Slot) {
    return this.#closedButStillHaveValuesInFlight.length > 0 && this.#closedButStillHaveValuesInFlight[0].values.length > 0 && this.#closedButStillHaveValuesInFlight[0].values[0] === slot
      || this.#active.type === 'iter' && this.#active.values.length > 0 && this.#active.values[0] === slot; // TODO think about whether this.#active.values can ever be empty
  }

  #truncateInFlightFrom(inFlight: InFlight, index: number) {
    // assert index >= 0; index < inFlight.values.length
    for (let i = index; i < inFlight.values.length; ++i) {
      const slot = inFlight.values[i];
      if (slot.type === 'value') {
        slot.value = null; // for memory reasons
      } else if (slot.type === 'error') {
        slot.error = null; // for memory reasons
      } else {
        // assert slot.type === 'awaiting';
      }
      slot.type = 'removed';
    }
    inFlight.values.length = index;
  }

  #issuePullFromCurrentActive() {
    // assert this.#active.type === 'iter'

    const slot: Slot = { type: 'awaiting' } as Slot; // the cast is not a no-op
    const inFlight = this.#active as InFlight;
    const thisIterValues = inFlight.values;
    const thisSlotIndex = thisIterValues.length;
    thisIterValues.push(slot);

    const actualIter = inFlight.iter as Nextable;

    fastPromiseTry(() => actualIter.next()).then(
      iterResult => {
        // got iterator result from non-underlying iterator

        if (slot.type === 'removed') return;
        // assert slot.type === 'awaiting'

        if ((iterResult as { done: boolean }).done) {
          const removedCount = thisIterValues.length - thisSlotIndex;
          // assert removedCount > 0: we have not already truncated this value
          this.#truncateInFlightFrom(inFlight, thisSlotIndex + 1);
          --thisIterValues.length; // also remove this slot
          if (thisIterValues.length === 0) {
            inFlight.iter = null; // for memory reasons
          }

          if (this.#active.type === 'iter') {
            if (this.#active.iter === actualIter) { // in real life this is a spec-internal IteratorRecord, so we don't have to worry about the case where the same iterator is returned twice
              if (thisIterValues.length > 0) {
                this.#closedButStillHaveValuesInFlight.push(this.#active);
              }
              this.#issuePullFromUnderlying(removedCount);

              // no need to process queue here: this cannot have been holding up any values except those from this iterator, which we're just dropping
            } else {
              // assert: this.#closedButStillHaveValuesInFlight.includes(inFlight)
              // strictly speaking, if thisIterValues is now empty we could remove it
              // but, no real reason to; we'll pop when it gets to the head of the queue

              for (let i = 0; i < removedCount; ++i) {
                this.#issuePullFromCurrentActive();
              }

              // head-of-queue case:
              if (this.#closedButStillHaveValuesInFlight[0] === inFlight && thisIterValues.length === 0) {
                this.#processQueue();
              }
            }
          } else if (this.#active.type === 'reading underlying') {
            this.#active.requested += removedCount;
          } else {
            // assert this.#active.type === 'error || this.#active.type === 'finished'

            this.#markSomeCallsAsNoLongerGettingValues(removedCount);
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
        // assert slot.type === 'awaiting'
        slot.type = 'error';
        const slotButWithTypeScript = slot as Extract<ErrorWithPossiblyTwoCloses, { closeState: 'awaiting-return' }>;
        slotButWithTypeScript.error = error;
        slotButWithTypeScript.closeState = 'awaiting-return';

        // TODO account for the case that one of the values being dropped has the return-promise in it
        // and... I guess promote it?
        // or reconsider this design; maybe that Promise doesn't live on error
        let dropped = thisIterValues.length - thisSlotIndex - 1; // -1 because we aren't dropping this slot
        this.#truncateInFlightFrom(inFlight, thisSlotIndex + 1);

        if (this.#active !== inFlight) {
          const indexOfThisInFlight = this.#closedButStillHaveValuesInFlight.indexOf(inFlight);
          // assert idx >= 0
          for (let i = indexOfThisInFlight + 1; i < this.#closedButStillHaveValuesInFlight.length; ++i) {
            const thatInFlight = this.#closedButStillHaveValuesInFlight[i];
            dropped += thatInFlight.values.length;
            this.#truncateInFlightFrom(thatInFlight, 0);
          }
        }
        // TODO consider order for this vs resolving with the error, in the case that slot is head-of-queue and we don't need to block on a .return call
        this.#markSomeCallsAsNoLongerGettingValues(dropped);

        if (this.#active.type === 'iter') {
          const active = this.#active;
          this.#closedButStillHaveValuesInFlight.push(this.#active);
          this.#active = { type: 'finished' };

          if (active === inFlight) {
            // just gotta close underlying
            this.#closeUnderlyingForError(slotButWithTypeScript as Error);
          } else {
            // gotta close both underlying and active, ugh
            // TODO consider whether to block on closing active before closing underlying

            let returnPromise1;
            try {
              returnPromise1 = (active as MaybeReturnable).return?.();
            } catch {
              // synchronous throw from return() gets swallowed
            }
            let returnPromise2;
            try {
              returnPromise2 = (this.#it as MaybeReturnable).return?.();
            } catch {
              // synchronous throw from return() gets swallowed
            }
            if (returnPromise1 === undefined && returnPromise2 === undefined) {
              (slotButWithTypeScript as Error).closeState = 'ready';
              if (this.#isHeadOfQueue(slot)) {
                this.#processQueue();
              }
            } else {
              slotButWithTypeScript.closeState = 'awaiting-return';
              if (returnPromise1 == undefined || returnPromise2 == undefined) {
                const onClosed = () => {
                  if (slotButWithTypeScript.reject) {
                    // assert slot.type !== 'removed'
                    slotButWithTypeScript.reject(error);
                  } else {
                    if ((slot as Slot).type === 'removed') return; // TODO make sure this is really what we want
                    (slot as Error).closeState = 'ready';
                    // assert: not head of queue
                  }
                };
                Promise.resolve(returnPromise1 ?? returnPromise2).then(onClosed, onClosed);
              } else {
                slotButWithTypeScript.count = 2;
                const onClosed = () => {
                  if (slotButWithTypeScript.count === 2) {
                    --slotButWithTypeScript.count;
                  } else if (slotButWithTypeScript.reject) {
                    // assert slot.type !== 'removed'
                    slotButWithTypeScript.reject(error);
                  } else {
                    if ((slot as Slot).type === 'removed') return; // TODO make sure this is really what we want
                    (slot as Error).closeState = 'ready';
                    // assert: not head of queue
                  }
                };
                Promise.resolve(returnPromise1).then(onClosed, onClosed);
                Promise.resolve(returnPromise1).then(onClosed, onClosed);
              }
            }
          }
          return;
        }
        if (this.#active.type === 'reading underlying') {
          this.#active = { type: 'finished' };
          this.#closeUnderlyingForError(slotButWithTypeScript as Error);
          return;
          // TODO do exceptions from the fn call at this point go into unhandled promise rejection
        }
        if (this.#active.type === 'error') {
          // we are going to squash this error
        }
        // assert this.#active.type === 'error' || this.
        // TODO processQueue, if this error was at head
      },
    );
  }

  #issuePullFromUnderlying(requested: number) {
    // assert: this.#active.type === 'unstarted' || this.#active.type === 'iter'; // latter case is when we just got { done: true } from previous active
    this.#active = { type: 'reading underlying', requested };

    fastPromiseTry(() => (this.#it as Nextable).next()).then(
      r => {
        if (this.#finished) return;

        // TODO handle done case


        fastPromiseTry(() => (this.#fn as (r: unknown) => AsyncIterable<unknown>)((r as { value: unknown }).value)).then(
          iter => {
            if (this.#finished) return;

            // TODO handle sync iterators / iterables
            // TODO consider how to deal with distinguishing sync iterator from async iterator
            try {
              // assert this.#active.type === 'reading underlying';
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
            this.#closeUnderlyingForErrorInMapper(error);
          }
        );
      },
      error => {
        if (this.#finished) return;

        this.#active = { type: 'error', error, closeState: 'ready' };
        // TODO only do this if #maxLiveInClosedButStillHaveValuesInFlight === 0?
        this.#processQueue();
        return;
      }
    );
  }

  // TODO: "is slot head of queue" helper

  #closeUnderlyingForErrorInMapper(error: unknown) {
    // assert: this.#active.type === 'reading underlying'
    const slot = { type: 'error', error, closeState: 'awaiting-return', reject: null, count: 1 } as const;
    this.#active = slot;
    this.#closeUnderlyingForError(slot);
  }

  #closeUnderlyingForError(slot: Error) {
    // assert: slot.type === 'error'
    // assert: slot.closeState === 'awaiting-return';

    // TODO truncate #calls at all callers

    let returnPromise;
    try {
      returnPromise = (this.#it as MaybeReturnable).return?.();
    } catch {
      // synchronous throw from it.return() gets swallowed
    }
    if (returnPromise === undefined) {
      slot.closeState = 'ready';
      // TODO process head-of-queue
      if (this.#isHeadOfQueue(slot)) {
        this.#processQueue();
      }
      return;
    }
    const onClosed = () => {
      // assert: slot.closeState === 'awaiting-return'
      const slotButWithTypeScript = slot as Extract<Error, { closeState: 'awaiting-return' }>;
      if (slotButWithTypeScript.reject) {
        slotButWithTypeScript.reject(slot.error);
      } else {
        slot.closeState = 'ready';
        // assert: not head of queue
      }
    };
    // TODO fast path for non-promise?
    Promise.resolve(returnPromise).then(onClosed, onClosed);
  }

  #processQueue() {
    // TODO
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
      // assert this.#active.type === 'iter'
      // cannot be error because we guarded on this.#finished above
      // TODO
    }
    return promise;
  }
}

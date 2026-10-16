import { fastPromiseTry, zalgo } from './util.ts';

export function flatMap(it: unknown, fn: unknown) {
  return new FlatMapHelper(it, fn);
}

function ASSERT(condition: boolean, message: string): asserts condition {
  if (!condition) {
    console.error('assert failed: ' + message, (new Error).stack);
    setTimeout(() => {
      throw new Error('an assertion failed, see stderr');
    }, 0); // do in a timeout so nothing can swallow it
  }
}

type Call = { resolve: (v: unknown) => void, reject: (v: unknown) => void };

// `call` is set once we know which position in the output this slot occupies
type Slot =
  | { type: 'awaiting', call: Call | null }
  | { type: 'value', value: unknown, call: Call | null }
  | ErrorSlot
  | { type: 'removed', call: null } // i.e. we already got { done: true } for this iterator at an earlier position

// For errors from the mapper or from inner iterators, we invoke .return() on whatever is still open (the underlying, and possibly an active inner iterator).
// Those calls must settle before the error is surfaced; `closing` is true until they do.
type ErrorSlot = { type: 'error', error: unknown, closing: boolean, call: Call | null };


/*
draining = we must wait for an in-flight underlying pull (and the mapper) to finish handing us the inner iterator so we can close it,
then close the underlying, before we are done.

we enter this state either by calling .return() while pulling underlying or waiting for the mapper,
or by getting an error from an earlier inner iterator while pulling underlying or waiting for the mapper

in the former case, we will have arranged not to resolve a call to result.next() so we have somewhere to put an error if the pull or mapper throws
if they finish without throwing, we resolve that call with { done: true }; errors from the calls to .return() can go into the result.return() call
*/
type DrainingState =
| {
    type: 'draining',
    returnCall: Call,
    errorSlot: null,
  }
| {
    type: 'draining',
    returnCall: null,
    errorSlot: ErrorSlot,
  };

type ActiveState =
  | { type: 'unstarted' }
  | { type: 'reading underlying', requested: number /* integer > 0 */ }
  | { type: 'iter', iter: unknown }
  | DrainingState
  | { type: 'finished' } // but still might be outstanding earlier calls


type Nextable = { next: () => unknown };
type MaybeReturnable = { return?: () => unknown };

class FlatMapHelper {
  #underlying: unknown;
  #fn: unknown;

  // one list per inner iterator, in order, holding the slots not yet bound to a call
  // if there is an active iterator, the last list is its slots (nothing gets pushed after it while it is active)
  // an error from the underlying or the mapper goes at the end as a list containing just that error
  // note that this does not hold the iterators themselves, so they can be GC'd
  // invariant: every slot in the first list is awaiting, since any settled slot there gets bound right away
  readonly #segments: Slot[][] = [];

  // the calls not yet bound to a slot
  // invariant: calls.length == [sum of lengths of segments] + [active.requested | (1 when draining because of .return()) | 0]
  #calls: Call[] = [];

  #active: ActiveState = { type: 'unstarted' };

  constructor(underlying: unknown, fn: unknown) {
    this.#underlying = underlying;
    this.#fn = fn;
  }

  #issuePullFromUnderlying() {
    ASSERT(this.#active.type === 'reading underlying', 'pull from underlying only after setting state appropriately');

    const onError = (error: unknown) => {
      // error from invoking/awaiting underlying.next(), or reading its .done or .value
      const active = this.#active;
      ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
      this.#active = { type: 'finished' };
      if (active.type === 'draining' && active.errorSlot) {
        // TODO should this be AggregateError?
        this.#commitError(active.errorSlot);
        return;
      }

      if (active.type === 'reading underlying') {
        this.#markSomeCallsAsNoLongerGettingValues(active.requested - 1); // -1 for the call which gets this error
      }
      const slot: ErrorSlot = { type: 'error', error, closing: false, call: null };
      const segment = [slot];
      this.#segments.push(segment);
      this.#slotSettled(slot, segment);

      // TODO maybe move this above; it's just here for tick ordering reasons we probably don't care about
      if (active.type === 'draining') {
        active.returnCall.resolve({ value: undefined, done: true });
      }
    };

    fastPromiseTry(() => (this.#underlying as Nextable).next()).then(
      r => {
        // successfully pulled underlying
        const active = this.#active;
        ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
        let done: unknown;
        let value: unknown;
        try {
          done = (r as { done: unknown }).done;
          if (!done) {
            // NB we don't await value; contract is non-promise here
            value = (r as { value: unknown }).value;
          }
        } catch (error) {
          onError(error);
          return;
        }
        if (done) {
          this.#active = { type: 'finished' };
          if (active.type === 'draining') {
            // if underlying was exhausted while we were waiting for it to close, the things that were waiting for it can just proceed
            if (active.errorSlot) {
              this.#commitError(active.errorSlot);
            } else {
              this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
              active.returnCall.resolve({ value: undefined, done: true });
            }
          } else {
            this.#markSomeCallsAsNoLongerGettingValues(active.requested);
          }
          return;
        }

        const onMapperResult = (iter: unknown) => {
          const active = this.#active;
          ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');

          // TODO handle sync iterators / iterables
          // TODO consider how to deal with distinguishing sync iterator from async iterator
          let actualIter: unknown;
          try {
            actualIter = (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]();
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
              this.#closeInnerThenUnderlying(actualIter as MaybeReturnable, (gotError, error) => gotError ? active.returnCall.reject(error) : active.returnCall.resolve({ done: true, value: undefined }));
            }
            return;
          }

          const { requested } = active;
          this.#segments.push([]);
          this.#active = { type: 'iter', iter: actualIter };

          // ok, time to actually pull
          for (let i = 0; i < requested; ++i) {
            // TODO worry about re-entrancy from calling .next()/.return() - probably is OK, just gotta make sure state is set appropriately before invoking user code
            this.#issuePullFromCurrentActive();
          }
        };
        const onMapperError = (error: unknown) => {
          this.#gotErrorFromMapper(error);
        };

        let mapped;
        try {
          mapped = (this.#fn as (r: unknown) => AsyncIterable<unknown>)(value);
        } catch (error) {
          onMapperError(error);
          return;
        }
        zalgo(mapped, onMapperResult, onMapperError);
      },
      onError,
    );
  }

  #issuePullFromCurrentActive() {
    ASSERT(this.#active.type === 'iter', 'we have an active iterator');

    const slot = { type: 'awaiting', call: null } as Slot;
    const inFlight = this.#active;
    ASSERT(this.#segments.length > 0, 'the active iterator has a segment');
    const thisIterValues = this.#segments.at(-1)!;
    thisIterValues.push(slot);

    const onError = (error: unknown) => {
      // error from inner iterator

      if (slot.type === 'removed') return;
      ASSERT(slot.type === 'awaiting', 'slot awaiting');
      const active = this.#active;
      // if we aren't yet closed, we need to block delivery of the error until the close we're about to trigger completes
      const slotButWithTypeScript = Object.assign(slot, { type: 'error' as const, error, closing: !this.#closed() });
      // this has to happen before we start closing things, because the closes can finish synchronously, at which point commitError will deliver
      this.#slotSettled(slotButWithTypeScript, thisIterValues);

      if (active.type === 'iter') {
        this.#active = { type: 'finished' };
        if (active === inFlight) {
          // just gotta close underlying
          this.#closeIterThen(this.#underlying as MaybeReturnable, () => this.#commitError(slotButWithTypeScript));
        } else {
          // gotta close both underlying and active
          this.#closeInnerThenUnderlying(active.iter as MaybeReturnable, () => this.#commitError(slotButWithTypeScript));
        }
      } else if (active.type === 'reading underlying') {
        this.#markSomeCallsAsNoLongerGettingValues(active.requested);
        this.#active = { type: 'draining', returnCall: null, errorSlot: slotButWithTypeScript };
      } else {
        ASSERT(this.#closed(), 'no longer issuing pulls');
        // nothing to close in this case
      }
    };

    fastPromiseTry(() => (inFlight.iter as Nextable).next()).then(
      iterResult => {
        // got iterator result from inner iterator

        if (slot.type === 'removed') return;
        ASSERT(slot.type === 'awaiting', 'slot awaiting');

        let done;
        let value;
        try {
          done = (iterResult as { done: unknown }).done;
          if (!done) {
            value = (iterResult as { value: unknown }).value;
          }
        } catch (error) {
          onError(error);
          return;
        }

        if (!done) {
          // we got a value! amazing!
          this.#slotSettled(Object.assign(slot, { type: 'value' as const, value }), thisIterValues);
          return;
        }

        // this and the check below are linear, but this path runs about once per inner iterator, so that's fine
        const currentIndex = thisIterValues.indexOf(slot);

        // a later pull from this iterator already settled (which is the only way this slot could have been bound, i.e. no longer be in the list)
        // that later result has already been given a position, so we can't just discard it
        if (currentIndex === -1 || thisIterValues.findLastIndex(s => s.type !== 'awaiting') > currentIndex) {
          onError(new TypeError('inner iterator returned { done: true } after a later pull already settled'));
          return;
        }

        // remove this slot and anything after it
        const removed = thisIterValues.splice(currentIndex);
        for (const r of removed) {
          ASSERT(r.type === 'awaiting' && r.call == null, 'only unbound awaiting slots are removed');
          Object.assign(r, { type: 'removed' as const });
        }

        const active = this.#active;
        if (active === inFlight) {
          this.#active = { type: 'reading underlying', requested: removed.length };
          this.#issuePullFromUnderlying();
        } else if (active.type === 'iter') {
          // i.e., we got a { done: true } from an inner iterator we already considered to be done
          // we just discarded any subsequent Promises from said iterator
          // so we need to re-issue those pulls on the currently active one
          // TODO this specific place definitely needs a reentrancy guard.
          for (let i = 0; i < removed.length; ++i) {
            this.#issuePullFromCurrentActive();
          }
        } else if (active.type === 'reading underlying') {
          active.requested += removed.length;
        } else {
          ASSERT(this.#closed(), 'no longer issuing pulls');
          this.#markSomeCallsAsNoLongerGettingValues(removed.length);
        }

        // if everything before this point in the iterator has already been bound, we now know its exact length,
        // and if it's also the first segment (i.e. the lengths of all earlier iterators are known), we can bind later segments' slots
        if (thisIterValues.length === 0 && thisIterValues === this.#segments[0]) {
          this.#clearFullyBoundSegments();
        }
      },
      onError,
    );
  }

  // ------------------ Error handling stuff ------------------

  // we were holding this error until some event finished, and it now has
  #commitError(slot: ErrorSlot) {
    ASSERT(slot.closing, 'error was pending');
    slot.closing = false;
    if (slot.call) {
      this.#deliver(slot);
    }
  }

  #gotErrorFromMapper(error: unknown) {
    const active = this.#active;
    ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
    this.#active = { type: 'finished' };
    if (active.type === 'draining' && active.errorSlot) {
      // TODO should this be AggregateError w/ the mapper error? ditto elsewhere
      this.#closeIterThen(this.#underlying as MaybeReturnable, () => this.#commitError(active.errorSlot));
      return;
    }
    if (active.type === 'reading underlying') {
      this.#markSomeCallsAsNoLongerGettingValues(active.requested - 1); // -1 for the call which gets this error
    }
    const slot: ErrorSlot = { type: 'error', error, closing: true, call: null };
    const segment = [slot];
    this.#segments.push(segment);
    this.#slotSettled(slot, segment);
    this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError, closeError) => {
      this.#commitError(slot);

      // TODO ordering for this vs above
      if (active.type === 'draining') {
        if (gotError) {
          active.returnCall.reject(closeError);
        } else {
          active.returnCall.resolve({ value: undefined, done: true });
        }
      }
    });
  }

  // ------------------ Iterator closing stuff ------------------

  // this is very zalgo but whatever
  #closeIterThen(iter: MaybeReturnable, next: (gotError: boolean, error?: unknown) => void): void {
    try {
      const ret = iter.return;
      if (ret == null) {
        next(false);
        return;
      }
      Promise.resolve(ret.call(iter)).then(() => next(false), e => next(true, e));
    } catch (error) {
      next(true, error);
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

  #markSomeCallsAsNoLongerGettingValues(removedCount: number) {
    ASSERT(removedCount <= this.#calls.length, 'removedCount <= calls.length');
    const mightStillGetValues = this.#calls.length - removedCount;
    for (let i = 0; i < removedCount; ++i) {
      this.#calls[mightStillGetValues + i].resolve({ value: undefined, done: true });
    }
    this.#calls.length = mightStillGetValues;
  }

  // ------------------ Utilities ------------------

  #closed() {
    return this.#active.type === 'draining' || this.#active.type === 'finished';
  }

  // ------------------ Delivery ------------------

  // `slot`, from `segment`, has settled
  #slotSettled(slot: Slot, segment: Slot[]) {
    ASSERT(slot.type === 'value' || slot.type === 'error', 'slot has settled');
    if (slot.call) {
      this.#deliver(slot);
    } else if (segment === this.#segments[0]) {
      // everything else in the head segment is awaiting, so this is now the last settled slot there
      this.#bindPrefix(segment.indexOf(slot));
      this.#clearFullyBoundSegments();
    }
    // otherwise we don't know its position yet
  }

  #deliver(slot: Slot) {
    ASSERT(slot.call != null, 'slot is bound');
    ASSERT(slot.type === 'value' || slot.type === 'error', 'slot has settled');
    if (slot.type === 'value') {
      slot.call.resolve({ value: slot.value, done: false });
    } else if (!slot.closing) {
      slot.call.reject(slot.error);
    }
  }

  // we either just settled a promise from the oldest inner iterator that still had unbound slots, or exposed a new such iterator
  // anything prior to the last settled promise in the head segment can be bound (and potentially delivered, if already available)
  // for convenience this also accepts -1 as an argument (when there is no settled promise in that segment), and does nothing in that case
  #bindPrefix(indexOfLastSettledSlotInHeadSegment: number) {
    const head = this.#segments[0];
    ASSERT(indexOfLastSettledSlotInHeadSegment < head.length && indexOfLastSettledSlotInHeadSegment < this.#calls.length, 'there are enough slots and calls to bind');
    for (let i = 0; i <= indexOfLastSettledSlotInHeadSegment; ++i) {
      const slot = head.shift()!;
      slot.call = this.#calls.shift()!;
      if (slot.type !== 'awaiting') {
        this.#deliver(slot);
      }
    }
  }

  #clearFullyBoundSegments() {
    const keep = this.#active.type === 'iter' ? 1 : 0;
    while (this.#segments.length > keep && this.#segments[0].length === 0) {
      this.#segments.shift();
      if (this.#segments.length > 0) {
        this.#bindPrefix(this.#segments[0].findLastIndex(slot => slot.type !== 'awaiting'));
      }
    }
  }

  // ------------------ Public API ------------------

  next() {
    if (this.#closed()) {
      return Promise.resolve({ value: undefined, done: true });
    }
    const { resolve, reject, promise } = Promise.withResolvers();
    this.#calls.push({ resolve, reject });
    if (this.#active.type === 'unstarted') {
      this.#active = { type: 'reading underlying', requested: 1 };
      this.#issuePullFromUnderlying();
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
      this.#active = { type: 'finished' };
      return new Promise((res, rej) => {
        this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError, error) => gotError ? rej(error) : res({ value: undefined, done: true }));
      });
    }
    if (this.#closed()) {
      return Promise.resolve({ value: undefined, done: true });
    }

    if (this.#active.type === 'reading underlying') {
      this.#markSomeCallsAsNoLongerGettingValues(this.#active.requested - 1); // -1 for the call we hold open in case of errors from the pull/mapper
      const { resolve, reject, promise } = Promise.withResolvers();
      this.#active = { type: 'draining', returnCall: { resolve, reject }, errorSlot: null };
      return promise;
    }

    ASSERT(this.#active.type === 'iter', 'active is iter');
    const active = this.#active;
    this.#active = { type: 'finished' };
    return new Promise((res, rej) => {
      this.#closeInnerThenUnderlying(active.iter as MaybeReturnable, (gotError, error) => gotError ? rej(error) : res({ value: undefined, done: true }));
    });
  }
}

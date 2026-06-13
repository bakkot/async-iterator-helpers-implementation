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
  | { type: 'done' } // edge case: a { done: true } delivered "like a value" (see the done handler)
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
  // A call is set to `null` once its value/error has been delivered out of order
  // (see #processQueue): it keeps its position so the lockstep with the slot queue
  // is preserved, and is spliced away when the leading run of delivered slots is
  // compacted. Trailing calls (bound to not-yet-existing slots) are never null.
  #calls: ({ resolve: (v: unknown) => void, reject: (v: unknown) => void } | null)[] = [];

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
      // trailing calls are bound to not-yet-delivered demand, so never null
      this.#calls[mightStillGetValues + i]!.resolve({ value: undefined, done: true });
    }
    this.#calls.length = mightStillGetValues;
  }

  // The values array of the head-of-queue iterator: the first parked iterator, or
  // the active iterator if none are parked (null if neither — e.g. reading the
  // underlying with nothing parked, or finished/errored). The head iterator's slot
  // at index i sits at global queue position i, so it binds to #calls[i] — which is
  // why its settled values/errors can be delivered out of order (like .map): we
  // already know which call each goes to. A non-head iterator's base position is
  // not yet fixed (the head iterator's length can still change), so its values stay
  // buffered until it reaches the head.
  #headValues(): Slot[] | null {
    if (this.#closedButStillHaveValuesInFlight.length > 0) return this.#closedButStillHaveValuesInFlight[0];
    if (this.#active.type === 'iter') return this.#active.values;
    return null;
  }

  // Would #processQueue act on this (just-settled) slot? Only if it is deliverable
  // now: an iterator slot is deliverable when its iterator (`values`) is at the head
  // — then it goes out of order — and the active-error slot (passed `values: null`)
  // when nothing is buffered ahead of it. A settled slot in a NON-head iterator is
  // buffered and #processQueue would not touch it, so callers guard on this to skip a
  // no-op sweep when they can tell they haven't disturbed the head. O(1): the caller
  // supplies the slot's own iterator array, so this is a reference check, not a scan.
  #slotIsDeliverable(slot: Slot, values: Slot[] | null): boolean {
    if (slot.type === 'removed') return false;
    if (values === null) return this.#active === slot && this.#closedButStillHaveValuesInFlight.length === 0;
    return this.#headValues() === values;
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
          // Find the current index: earlier slots of this iterator may have been
          // delivered (and shifted off) since this pull was issued, so an index
          // captured at issue time would be stale.
          const currentIndex = thisIterValues.indexOf(slot);
          ASSERT(currentIndex >= 0, 'slot still present');

          // EDGE CASE: this iterator is at the head of the queue and a LATER pull of
          // it was already delivered out of order (its call is null). Truncating from
          // this done would discard that already-delivered value (and could clobber a
          // committed-but-still-closing error). So for now we punt: mark this slot as
          // a `done` and let #processQueue deliver it "like a value" to its own call.
          // We do NOT truncate, redirect demand, or close anything — the bookkeeping
          // is left as-is, which puts a done ahead of a later value in call order and
          // can leave a self-finished iterator nominally active. This is provisional
          // and slated to change; the fuzzer exempts runs that hit it (and the harmless
          // close/re-pull of an already-done inner it can cause). See flatMap-fuzzer.js.
          if (this.#headValues() === thisIterValues) {
            for (let j = currentIndex + 1; j < thisIterValues.length; ++j) {
              if (this.#calls[j] == null) {
                slot.type = 'done';
                this.#processQueue();
                return;
              }
            }
          }

          const removedCount = thisIterValues.length - currentIndex;
          ASSERT(removedCount > 0, 'have not already truncated this value');

          // Does removing these slots pop the front of the queue, revealing something
          // buffered behind this iterator? Only if this pull is the head of its own
          // iterator (currentIndex === 0) AND that iterator is the front of the closed
          // queue. Within-iterator out-of-order delivery already happened as slots
          // settled, so a done only newly enables delivery when it exposes a new head.
          // Capture before truncating pops it.
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

          // Deliver it now if it is in the head iterator (out of order if earlier
          // pulls are still outstanding); if it is buffered behind another iterator,
          // #processQueue would do nothing, so don't bother.
          if (this.#slotIsDeliverable(slot, thisIterValues)) {
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
          const active = this.#active;
          this.#closedButStillHaveValuesInFlight.push(active.values);
          this.#active = { type: 'finished' };

          if (active === inFlight) {
            // just gotta close underlying
            this.#closeUnderlyingForError(slotButWithTypeScript as ErrorState, thisIterValues);
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
            // Commit the call waiting on this slot before the closes settle (if it is
            // deliverable now), so onClosed has a rejector to invoke; otherwise we
            // mark it ready and it surfaces when its iterator reaches the head.
            if (this.#slotIsDeliverable(slot, thisIterValues)) {
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
                ASSERT(!this.#slotIsDeliverable(slot, thisIterValues), 'not deliverable');
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
          this.#closeUnderlyingForError(slotButWithTypeScript as ErrorState, thisIterValues);
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
          if (this.#slotIsDeliverable(slot, thisIterValues)) {
            this.#processQueue();
          }
          return;
        }
        ASSERT(this.#active.type === 'error' || this.#active.type === 'finished', 'active is error or finished');
        // nothing to close in this case
        (slot as ErrorState).closeState = 'ready';
        if (this.#slotIsDeliverable(slot, thisIterValues)) {
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

  // The underlying produced a value while draining but we failed to map it (the
  // mapper threw or rejected, or obtaining the inner iterator threw). Like any
  // mapper error this closes the underlying — deferred until now — and the error
  // surfaces to the held call (the first call not bound to a buffered value) only
  // once that close settles. result.return() then settles from the close's outcome.
  #drainingErrorFromMapper(d: DrainingState, error: unknown) {
    ASSERT(this.#active === d, 'active is the draining state');
    const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
    this.#active = slot;
    // Commit the call (if this error is deliverable now) via the active-error tail so
    // the close reaction has a rejector; otherwise it surfaces when it reaches the head.
    if (this.#slotIsDeliverable(slot, null)) {
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
        ASSERT(!this.#slotIsDeliverable(slot, null), 'not deliverable');
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
            this.#active = { type: 'iter', iter: actualIter, values: [] };

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
          if (this.#closedButStillHaveValuesInFlight.length === 0) {
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
    const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
    this.#markSomeCallsAsNoLongerGettingValues(requested - 1);
    this.#active = slot;
    this.#closeUnderlyingForError(slot, null);
  }

  // `values` is the slot's iterator array (for an error parked in an inner iterator),
  // or null when `slot` is the active-error slot (a mapper/iterator error while
  // reading the underlying), so #slotIsDeliverable can decide deliverability in O(1).
  #closeUnderlyingForError(slot: ErrorState, values: Slot[] | null) {
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
      if (this.#slotIsDeliverable(slot, values)) {
        this.#processQueue();
      }
      return;
    }
    // Commit the error to its call (if deliverable now) so onClosed has a rejector;
    // otherwise it is committed when it reaches the head.
    if (this.#slotIsDeliverable(slot, values)) {
      this.#processQueue();
    }
    const onClosed = () => {
      ASSERT(slot.closeState === 'awaiting-return', 'slot awaiting-return');
      const slotButWithTypeScript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
      if (slotButWithTypeScript.reject) {
        slotButWithTypeScript.reject(slot.error);
      } else {
        slot.closeState = 'ready';
        ASSERT(!this.#slotIsDeliverable(slot, values), 'not deliverable');
      }
    };
    // TODO fast path for non-promise?
    Promise.resolve(returnPromise).then(onClosed, onClosed);
  }

  // Deliver a settled slot to its call. Returns true if the call was consumed (so
  // the caller can null #calls at that position); false for an awaiting/removed slot.
  #deliverSlot(slot: Slot, call: { resolve: (v: unknown) => void, reject: (v: unknown) => void }): boolean {
    if (slot.type === 'value') {
      call.resolve({ value: slot.value, done: false });
      return true;
    }
    if (slot.type === 'done') {
      // Edge case: a { done: true } delivered "like a value" (see the done handler).
      call.resolve({ value: undefined, done: true });
      return true;
    }
    if (slot.type === 'error') {
      if (slot.closeState === 'awaiting-return') {
        // The triggered .return() has not settled yet: commit this call by leaving a
        // rejector for the close reaction, and let the slot drop from the queue.
        (slot as Extract<ErrorState, { closeState: 'awaiting-return' }>).reject = call.reject;
      } else {
        ASSERT(slot.closeState === 'ready', 'closeState ready');
        call.reject(slot.error);
      }
      return true;
    }
    // 'awaiting' or 'removed'
    return false;
  }

  #processQueue() {
    // Deliver everything currently deliverable. Within the head-of-queue iterator a
    // settled slot is delivered out of order — slot i binds to #calls[i] — so a
    // value/error sitting behind a still-awaiting earlier pull goes to its own call
    // right away (like .map). A later iterator's values stay buffered until the head
    // iterator fully drains, because their global positions are not yet fixed.
    while (true) {
      const head = this.#headValues();
      if (head == null) break;
      for (let i = 0; i < head.length; ++i) {
        const call = this.#calls[i];
        if (call == null) continue; // already delivered out of order
        if (this.#deliverSlot(head[i], call)) this.#calls[i] = null;
      }
      // Compact the leading run of delivered (consumed) slots, in lockstep.
      let removed = 0;
      while (removed < head.length && this.#calls[removed] == null) ++removed;
      if (removed > 0) {
        head.splice(0, removed);
        this.#calls.splice(0, removed);
      }
      if (head.length > 0) break; // the front slot is still awaiting; cannot advance
      // The head iterator is fully delivered: drop it and expose the next one.
      if (this.#closedButStillHaveValuesInFlight.length > 0 && this.#closedButStillHaveValuesInFlight[0] === head) {
        this.#closedButStillHaveValuesInFlight.shift();
        continue;
      }
      break; // head was the (now-empty) active iterator's values
    }
    // Once nothing is buffered ahead, surface a pending underlying/mapper error.
    if (this.#closedButStillHaveValuesInFlight.length === 0 && this.#active.type === 'error') {
      const call = this.#calls.shift()!;
      if (this.#active.closeState === 'ready') {
        call.reject(this.#active.error);
      } else {
        this.#active.reject = call.reject;
      }
      this.#active = { type: 'finished' };
      // TODO maybe errors just go as a length-1 entry on top of closedButStillHaveValuesInFlight?
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
    const active = this.#active as InFlight;
    this.#markUnderlyingAsFinished();
    return this.#closeInnerThenUnderlying(active.iter);
  }
}

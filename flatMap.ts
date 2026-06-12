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

// The outcome of a close (.return()) we performed, captured so it never rejects on
// its own — we compose these to settle result.return()'s promise.
type CloseOutcome = { ok: true } | { ok: false, error: unknown };

// For errors from the mapper or from result iterators, we invoke .return() on
// whatever is still open (the underlying, and possibly an active inner iterator).
// Those calls must settle before the error is surfaced.
type ErrorState =
  | { type: 'error', error: unknown, closeState: 'ready', reject?: null }
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void) }

type ReadingUnderlyingState = { type: 'reading underlying', requested: number /* integer > 0 */ };

// return() landed while we were reading the underlying for the next inner iterator.
// We are committed to closing, so we will NOT pull the iterator that pull produces:
// the surplus bound demand was doned eagerly and the underlying was closed eagerly
// (its outcome is captured in `uCloseSettled`). One bound call is held — the position
// a pull/mapper rejection would land on. When the in-flight pull/mapper settle we
// close the produced iterator (if any) WITHOUT pulling it and done the held call.
// result.return() (resolveReturn/rejectReturn) waits for BOTH the underlying close
// and any inner close, which can be outstanding concurrently. Draining always
// logically requests exactly one value — the held call, which is the last of
// #calls; the buffered parked values keep the calls before it. When parked slots
// truncate (an inner reports done), the freed calls are the LAST ones — the held
// position shifts earlier, since results deliver in call order and the rejection
// lands on the first call not bound to a surviving buffered value.
type DrainingState = {
  type: 'draining',
  resolveReturn: (v: unknown) => void,
  rejectReturn: (e: unknown) => void,
  uCloseSettled: Promise<CloseOutcome>,
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
          // pull. The underlying is already closing (eagerly), so we don't close it
          // again; the pending bound demand can never be filled now the stream is
          // truncated here, so done it (the in-flight pull's result is discarded once
          // we're finished). The error itself still reaches the call at this slot's
          // position, and result.return() waits for the eager underlying close.
          const d = this.#active;
          this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
          this.#finalizeReturnAfterUnderlyingClose(d);
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

  // The underlying pull rejected while draining: the underlying exhausted itself, so
  // the error surfaces to the head-most pending call immediately (after any buffered
  // values); the eager underlying close only gates result.return(). Buffered values
  // keep their calls and the rest of the pending demand is doned.
  #drainingErrorFromUnderlying(d: DrainingState, error: unknown) {
    ASSERT(this.#active === d, 'active is the draining state');
    this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#bufferedValueCount() - 1);
    this.#finalizeReturnAfterUnderlyingClose(d);
    this.#active = { type: 'error', error, closeState: 'ready' };
    if (this.#closedButStillHaveValuesInFlight.length === 0) {
      this.#processQueue();
    }
  }

  // The underlying produced a value while draining but we failed to map it (the
  // mapper threw or rejected, or obtaining the inner iterator threw). Like any mapper
  // error, it surfaces only after the underlying close settles — here the eager close
  // already in flight. The head-most pending call is the error sink; buffered values
  // keep their calls and the rest of the pending demand is doned. No inner was
  // produced, so result.return() waits only for the eager underlying close.
  #drainingErrorFromMapper(d: DrainingState, error: unknown) {
    ASSERT(this.#active === d, 'active is the draining state');
    this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#bufferedValueCount() - 1);
    const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
    this.#active = slot;
    // Commit the call (if this is the head) so the close reaction has a rejector;
    // otherwise it surfaces when it reaches the head.
    if (this.#isHeadOfQueue(slot)) {
      this.#processQueue();
    }
    d.uCloseSettled.then(() => {
      const s = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
      if (s.reject) {
        s.reject(error);
      } else if ((slot as Slot).type !== 'removed') {
        (slot as ErrorState).closeState = 'ready';
      }
    });
    // Registered after the rejection reaction above so the held call rejects
    // before result.return() resolves.
    this.#finalizeReturnAfterUnderlyingClose(d);
  }

  // Run `thunk` (a .return() call) and capture its outcome as a never-rejecting
  // promise, so several closes can be composed without unhandled rejections.
  #captureClose(thunk: () => unknown): Promise<CloseOutcome> {
    return fastPromiseTry(thunk).then(
      () => ({ ok: true } as CloseOutcome),
      (error) => ({ ok: false, error } as CloseOutcome),
    );
  }

  // Settle result.return() once the eager underlying close has settled (no inner was
  // produced). It resolves done unless that close failed, in which case it rejects
  // with that error.
  #finalizeReturnAfterUnderlyingClose(d: DrainingState) {
    d.uCloseSettled.then(outcome => {
      if (outcome.ok) {
        d.resolveReturn({ value: undefined, done: true });
      } else {
        d.rejectReturn(outcome.error);
      }
    });
  }

  // Settle result.return() once both the inner close and the eager underlying close
  // have settled. It resolves done unless a close failed, in which case it rejects
  // with that error — the inner close taking precedence.
  #finalizeReturnAfterBothCloses(d: DrainingState, iCloseSettled: Promise<CloseOutcome>) {
    Promise.all([iCloseSettled, d.uCloseSettled]).then(([iOutcome, uOutcome]) => {
      if (!iOutcome.ok) {
        d.rejectReturn(iOutcome.error);
      } else if (!uOutcome.ok) {
        d.rejectReturn(uOutcome.error);
      } else {
        d.resolveReturn({ value: undefined, done: true });
      }
    });
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
            this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
            this.#finalizeReturnAfterUnderlyingClose(active);
            this.#active = { type: 'finished' };
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
              // Less-eager: we don't pull this iterator. Close it RIGHT AWAY (it was
              // never pulled, so it cannot have finished on its own — no .return()-
              // after-done hazard), done the pending bound demand, and have
              // result.return() wait for BOTH the eager underlying close and this
              // inner close.
              const iCloseSettled = this.#captureClose(() => (actualIter as MaybeReturnable).return?.());
              this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
              this.#active = { type: 'finished' };
              this.#finalizeReturnAfterBothCloses(active, iCloseSettled);
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
            if (active.type !== 'reading underlying' && active.type !== 'draining') return;
            if (active.type === 'draining') {
              this.#drainingErrorFromMapper(active, error);
              return;
            }
            this.#closeUnderlyingForErrorInMapper(error);
          }
        );
      },
      error => {
        const active = this.#active;
        if (active.type !== 'reading underlying' && active.type !== 'draining') return;
        if (active.type === 'draining') {
          this.#drainingErrorFromUnderlying(active, error);
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
      // pending). We're committed to closing, so we will NOT pull whatever iterator
      // that pull produces. The bound demand can't receive a value, so done the
      // trailing surplus eagerly and HOLD the head-most bound call (the position a
      // pull/mapper rejection would land on). Close the underlying EAGERLY now, and
      // switch to 'draining': when the pull/mapper settle we close the produced
      // iterator (if any) without pulling it and done the held call. return() waits
      // for both closes (see #finalizeReturnAfterBothCloses).
      this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#bufferedValueCount() - 1);
      const uCloseSettled = this.#captureClose(() => (this.#underlying as MaybeReturnable).return?.());
      const { resolve, reject, promise } = Promise.withResolvers();
      this.#active = {
        type: 'draining',
        resolveReturn: resolve,
        rejectReturn: reject,
        uCloseSettled,
      };
      return promise;
    }

    // active is an inner iterator. Park it (its in-flight pulls keep delivering),
    // then close it and the underlying in sequence — active iterator first.
    // TODO order of truncation vs resolving this Promise
    const active = this.#active as InFlight;
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

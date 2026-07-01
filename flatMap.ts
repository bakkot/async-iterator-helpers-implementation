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

// https://github.com/tc39/ecma262/pull/3883
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
  | { type: 'delivered' } // its value (or error) has already been handed to its call; kept in place so positions of later slots are stable
  | { type: 'removed' } // i.e. we already got { done: true } for this iterator at an earlier position

type ReadingUnderlyingState = { type: 'reading underlying', requested: number /* integer > 0 */ };

// Per-inner-iterator bookkeeping, shared between the active state and the queue of
// closed-but-not-yet-drained iterators.
//
// minLength/maxLength bound how many values the iterator still contributes,
// relative to slots[0] (both are decremented when slots are shifted off the head):
// seeing a value (or error) at index i tells us positions 0..i all exist, so
// minLength >= i+1; seeing { done: true } at index i tells us position i and later
// don't exist, so maxLength = i (it is Infinity until then — including for
// iterators that stop being active without reporting done, e.g. because the
// consumer called return(), whose remaining length we never learn).
//
// When minLength === maxLength we know EXACTLY how many values the iterator has
// left, so the positions of everything queued after it are known and values from
// later iterators can be delivered without waiting for this one to drain.
type InnerIterEntry = { minLength: number, maxLength: number, slots: Slot[] };

type ActiveInnerIterState = { type: 'iter', iter: unknown, entry: InnerIterEntry }

// For errors from the mapper or from inner iterators, we invoke .return() on whatever is still open (the underlying, and possibly an active inner iterator).
// Those calls must settle before the error is surfaced.
type ErrorState =
  | { type: 'error', error: unknown, closeState: 'ready', reject?: null }
  | { type: 'error', error: unknown, closeState: 'awaiting-return', reject: null | ((e: unknown) => void) }


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
    resolveReturn: ((v: unknown) => void),
    rejectReturn: ((v: unknown) => void),
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
  | ActiveInnerIterState // invariant: while active,
  | DrainingState
  | ErrorState // specifically in this position this means an error when reading from underlying or invoking the mapper
  | { type: 'finished' } // but still might be outstanding earlier calls, to be settled by closedButStillHaveValuesInFlight


type Nextable = { next: () => unknown };
type MaybeReturnable = { return?: () => unknown };

class FlatMapHelper {
  #underlying: unknown;
  #fn: unknown;

  // holds the entries of closed iterators (not the ActiveInnerIterState objects, so the iterators themselves can be GC'd)
  readonly #closedButStillHaveValuesInFlight: InnerIterEntry[] = [];

  #active: ActiveState = { type: 'unstarted' };

  // invariant: calls.length == [sum of undelivered slot counts of closedButStillHaveValuesInFlight]
  //   + [active.requested | undelivered slot count of active.entry | (1 when draining or when active is an undelivered error)]
  // the i-th call corresponds to the i-th undelivered slot, in queue order; delivering a slot
  // splices its call out, so the correspondence is maintained
  #calls: { resolve: (v: unknown) => void, reject: (v: unknown) => void }[] = [];

  constructor(underlying: unknown, fn: unknown) {
    this.#underlying = underlying;
    this.#fn = fn;
  }

  #issuePullFromUnderlying() {
    ASSERT(this.#active.type === 'reading underlying', 'pull from underlying only after setting state appropriately');

    fastPromiseTry(() => (this.#underlying as Nextable).next()).then(
      r => {
        // successfully pulled underlying
        const active = this.#active;
        ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
        if ((r as { done: boolean }).done) {
          if (active.type === 'draining') {
            // if underlying was exhausted while we were waiting for it to close, the things that were waiting for it can just proceed
            if (active.errorSlot) {
              this.#commitError(active.errorSlot);
            } else {
              this.#markSomeCallsAsNoLongerGettingValues(1); // the held call
              active.resolveReturn({ value: undefined, done: true });
            }
          } else {
            this.#markUnderlyingAsFinished();
          }
          this.#active = { type: 'finished' };
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
                this.#closeInnerThenUnderlying(actualIter as MaybeReturnable, (gotError, error) => gotError ? active.rejectReturn(error) : active.resolveReturn({ done: true, value: undefined }));
              }
              return;
            }

            const { requested } = active as Extract<ActiveState, { type: 'reading underlying '}>;
            this.#active = { type: 'iter', iter: actualIter, entry: { minLength: 0, maxLength: Infinity, slots: [] } };

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
          // TODO should this be AggregateError?
          this.#active = { type: 'finished' };
          this.#commitError(active.errorSlot);
          return;
        }

        if (active.type === 'reading underlying') {
          this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#valuesWeCouldDeliverFromClosedInnerIterators() - 1); // -1 for the slot we hold open in case of errors from the pull/mapper
        }

        // an error from the underlying counts as it closing itself, so no .return() is needed and the error is ready to deliver
        this.#active = { type: 'error', error, closeState: 'ready' };
        if (this.#allClosedExact()) {
          // we know exactly where the error goes (right after the last value of the last closed iterator), so deliver it now
          this.#processQueue();
        }

        // TODO maybe move this above; it's just here for tick ordering reasons we probably don't care about
        if (active.type === 'draining') {
          active.resolveReturn({ value: undefined, done: true });
        }
      }
    );
  }

  #issuePullFromCurrentActive() {
    ASSERT(this.#active.type === 'iter', 'we have an active iterator');

    const slot = { type: 'awaiting' } as Slot;
    const inFlight = this.#active as ActiveInnerIterState;
    const entry = inFlight.entry;
    entry.slots.push(slot);

    fastPromiseTry(() => (inFlight.iter as Nextable).next()).then(
      iterResult => {
        // got iterator result from inner iterator

        if (slot.type === 'removed') return;
        ASSERT(slot.type === 'awaiting', 'slot awaiting');

        if ((iterResult as { done: boolean }).done) {
          ASSERT(this.#closedButStillHaveValuesInFlight.includes(entry) || this.#active === inFlight, 'entry is still tracked');

          // I am assuming this can be done cheaply, possibly with a slightly different data structure
          // though also in practice N is small enough for it not to matter
          const currentIndex = entry.slots.indexOf(slot);
          ASSERT(currentIndex >= 0, 'slot is still present');

          if (currentIndex < entry.minLength) {
            // We have already seen (and possibly delivered) a value or error at a LATER
            // position, which this { done: true } would retroactively drop: the iterator
            // is ill-behaved. Surface an error at this position instead.
            this.#gotErrorFromInner(slot, entry, inFlight, new TypeError('ill-behaved inner iterator'));
            return;
          }

          const removedCount = entry.slots.length - currentIndex;
          ASSERT(removedCount > 0, 'have not already truncated this value');

          // remove this slot and anything after it
          // (anything settled at those positions would have raised minLength past
          // currentIndex, so everything removed here is still awaiting)
          for (let i = currentIndex; i < entry.slots.length; ++i) {
            const s = entry.slots[i];
            ASSERT(s.type === 'awaiting', 'truncated slots are awaiting');
            s.type = 'removed';
          }
          entry.slots.length = currentIndex;
          entry.maxLength = currentIndex;
          ASSERT(entry.minLength <= entry.maxLength, 'minLength <= maxLength');

          if (this.#active.type === 'iter') {
            if (this.#active === inFlight) {
              if (currentIndex > 0) {
                this.#closedButStillHaveValuesInFlight.push(entry);
              }
              this.#active = { type: 'reading underlying', requested: removedCount };
              this.#issuePullFromUnderlying();
              // nothing is queued after this iterator, so learning its length can't unblock anything
              return;
            }
            // i.e., we got a { done: true } from an inner iterator we already considered to be done
            // we just discarded any subsequent Promises from said iterator
            // so we need to re-issue those pulls on the currently active one

            // strictly speaking, if entry.slots is now empty we could remove it from closedButStillHaveValuesInFlight
            // but, no real reason to; we'll pop when it gets to the head of the queue

            for (let i = 0; i < removedCount; ++i) {
              this.#issuePullFromCurrentActive();
            }
          } else if (this.#active.type === 'reading underlying') {
            this.#active.requested += removedCount;
          } else {
            ASSERT(this.#closed(), 'no longer issuing pulls');

            this.#markSomeCallsAsNoLongerGettingValues(removedCount);
          }

          // if this done pinned the iterator's exact length (or drained it entirely),
          // values queued after it may now be deliverable
          if (entry.minLength === entry.maxLength && this.#allExactBefore(entry)) {
            this.#processQueue();
          }
        } else {
          // we got a value! amazing!
          const { value } = (iterResult as { value: unknown });
          slot.type = 'value';
          (slot as Extract<Slot, { type: 'value' }>).value = value;

          const currentIndex = entry.slots.indexOf(slot);
          ASSERT(currentIndex >= 0, 'slot is still present');
          if (currentIndex + 1 > entry.minLength) {
            entry.minLength = currentIndex + 1;
          }

          // the k-th undelivered slot of this iterator feeds the k-th outstanding call
          // aimed at it, so this value's destination is known — unless some earlier
          // iterator's length is unknown, in which case it buffers until then
          if (this.#allExactBefore(entry)) {
            this.#processQueue();
          }
        }
      },
      error => {
        // got error from inner iterator

        if (slot.type === 'removed') return;
        this.#gotErrorFromInner(slot, entry, inFlight, error);
      },
    );
  }

  // ------------------ Error handling stuff ------------------

  // an error at `slot` (which belongs to `entry`, the bookkeeping for `inFlight`'s iterator):
  // either the pull rejected, or the iterator was ill-behaved (see above), which we treat the
  // same way — in particular the erroring iterator itself is never closed (a rejected next()
  // exhausts it; an ill-behaved one claimed to be done)
  #gotErrorFromInner(slot: Slot, entry: InnerIterEntry, inFlight: ActiveInnerIterState, error: unknown) {
    ASSERT(slot.type === 'awaiting', 'slot awaiting');
    slot.type = 'error';
    const slotButWithTypeScript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
    slotButWithTypeScript.error = error;

    const currentIndex = entry.slots.indexOf(slot);
    ASSERT(currentIndex >= 0, 'slot is still present');
    if (currentIndex + 1 > entry.minLength) {
      entry.minLength = currentIndex + 1;
    }

    if (this.#active.type === 'iter') {
      slotButWithTypeScript.closeState = 'awaiting-return';
      const active = this.#active;
      ASSERT(active.entry.slots.length > 0, 'active has at least one outstanding');
      this.#closedButStillHaveValuesInFlight.push(active.entry);
      this.#active = { type: 'finished' };

      if (active === inFlight) {
        // just gotta close underlying
        this.#closeIterThen(this.#underlying as MaybeReturnable, () => this.#commitError(slotButWithTypeScript));
      } else {
        // gotta close both underlying and active
        const activeIter = active.iter;

        this.#closeInnerThenUnderlying(activeIter as MaybeReturnable, () => this.#commitError(slotButWithTypeScript));
      }
    } else if (this.#active.type === 'reading underlying') {
      slotButWithTypeScript.closeState = 'awaiting-return';
      this.#markSomeCallsAsNoLongerGettingValues(this.#active.requested);
      this.#active = { type: 'draining', resolveReturn: null, errorSlot: slotButWithTypeScript };
    } else {
      ASSERT(this.#closed(), 'no longer issuing pulls');
      // nothing to close in this case
      (slot as ErrorState).closeState = 'ready';
    }
    // an error occupies its position just like a value, so it can be committed to its
    // call as soon as its destination is known (though if a close is in flight the
    // rejection itself waits for that close to settle)
    if (this.#allExactBefore(entry)) {
      this.#processQueue();
    }
  }

  // we were holding this error until some event finished, and it now has
  #commitError(slot: ErrorState) {
    ASSERT(slot.closeState === 'awaiting-return', 'error was pending');
    const slotButWithTypescript = slot as Extract<ErrorState, { closeState: 'awaiting-return' }>;
    if (slotButWithTypescript.reject) {
      slotButWithTypescript.reject(slot.error);
    } else {
      (slot as ErrorState).closeState = 'ready';
      // if this error is already deliverable, caller is responsible for dealing with that
      // this is generally only possible if the above-mentioned events we were waiting for took zero ticks
    }
  }

  #gotErrorFromMapper(error: unknown) {
    const active = this.#active;
    ASSERT(active.type == 'reading underlying' || active.type == 'draining', 'reading underlying can only transition to draining');
    if (active.type === 'draining') {
      if (active.errorSlot) {
        this.#active = { type: 'finished' };
          // TODO should this be AggregateError w/ the mapper error? ditto elsewhere
        this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError, error) => this.#commitError(active.errorSlot));
      } else {
        const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
        this.#active = slot;
        if (this.#allClosedExact()) {
          this.#processQueue();
        }
        this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError, closeError) => {
          this.#commitError(slot);

          // TODO ordering for this vs above
          if (gotError) {
            active.rejectReturn(closeError);
          } else {
            active.resolveReturn({ value: undefined, done: true });
          }
        });
      }
      return;
    }
    const { requested } = this.#active as ReadingUnderlyingState;
    const slot: ErrorState = { type: 'error', error, closeState: 'awaiting-return', reject: null };
    this.#markSomeCallsAsNoLongerGettingValues(requested - 1); // -1 for this error
    this.#active = slot;
    if (this.#allClosedExact()) {
      this.#processQueue();
    }
    this.#closeIterThen(this.#underlying as MaybeReturnable, (gotError, error) => this.#commitError(slot));
  }

  // ------------------ Iterator closing stuff ------------------

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

  #markUnderlyingAsFinished() {
    ASSERT(this.#active.type === 'reading underlying' || this.#active.type === 'iter', 'active is reading underlying or iter'); // latter only via return()
    if (this.#active.type === 'iter' && this.#active.entry.slots.length > 0) {
      // NB: its maxLength stays Infinity — we never learn how long it would have been —
      // but nothing will ever be queued after it, so that can't hold anything up
      this.#closedButStillHaveValuesInFlight.push(this.#active.entry);
    }
    this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#valuesWeCouldDeliverFromClosedInnerIterators());
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
    return this.#active.type === 'error' || this.#active.type === 'draining' || this.#active.type === 'finished';
  }

  #undeliveredCount(entry: InnerIterEntry) {
    let count = 0;
    for (const slot of entry.slots) {
      if (slot.type !== 'delivered') ++count;
    }
    return count;
  }

  #valuesWeCouldDeliverFromClosedInnerIterators() {
    return this.#closedButStillHaveValuesInFlight.reduce((acc, entry) => acc + this.#undeliveredCount(entry), 0);
  }

  // whether every queued iterator before `entry` has a known exact length, i.e.
  // whether the destinations of `entry`'s slots are known
  #allExactBefore(entry: InnerIterEntry) {
    for (const e of this.#closedButStillHaveValuesInFlight) {
      if (e === entry) return true;
      if (e.minLength !== e.maxLength) return false;
    }
    return true; // `entry` is the active iterator's, which comes after all the closed ones
  }

  // ditto, for things which come after every queued iterator (a terminal error)
  #allClosedExact() {
    return this.#closedButStillHaveValuesInFlight.every(e => e.minLength === e.maxLength);
  }

  // ------------------ Queue processing ------------------

  // Deliver every settled slot whose destination is known: walk the queue from the
  // head, delivering settled slots to their calls, until an iterator whose exact
  // length is unknown blocks everything after it. Also drops delivered slots from
  // the head of the queue (and drained iterators with them) as they can no longer
  // affect anything.
  //
  // Callers gate invocations on the relevant prefix of the queue being exact, so a
  // call to this always delivers something... except when it is merely dropping a
  // drained head entry, or when the only deliverable slots were already delivered
  // eagerly. It's cheap in those cases.
  #processQueue() {
    const closed = this.#closedButStillHaveValuesInFlight;
    // drop delivered slots at the head of the queue, and drained iterators with them
    while (closed.length > 0) {
      const head = closed[0];
      while (head.slots.length > 0 && head.slots[0].type === 'delivered') {
        head.slots.shift();
        ASSERT(head.minLength > 0, 'delivered slots count towards minLength');
        --head.minLength;
        --head.maxLength;
      }
      if (head.slots.length > 0) break;
      closed.shift();
    }

    let offset = 0; // total undelivered slots in the entries walked so far == index of the next call fed by anything after them
    for (const entry of closed) {
      offset += this.#deliverSettledSlots(entry, offset);
      if (entry.minLength !== entry.maxLength) {
        // this iterator's length is unknown, so the destinations of everything after it are too
        return;
      }
    }

    if (this.#active.type === 'error') {
      // a terminal error from the underlying or the mapper; it goes to the last outstanding call
      ASSERT(offset === this.#calls.length - 1, 'the terminal error is the last outstanding call');
      const active = this.#active;
      const call = this.#calls.pop()!;
      this.#active = { type: 'finished' };
      if (active.closeState === 'awaiting-return') {
        active.reject = call.reject;
      } else {
        ASSERT(active.closeState === 'ready', 'closeState ready');
        call.reject(active.error);
      }
      return;
    }
    if (this.#active.type === 'iter') {
      const entry = this.#active.entry;
      this.#deliverSettledSlots(entry, offset);
      if (closed.length === 0) {
        // the active iterator is at the head of the queue, so its delivered slots can be dropped too
        while (entry.slots.length > 0 && entry.slots[0].type === 'delivered') {
          entry.slots.shift();
          ASSERT(entry.minLength > 0, 'delivered slots count towards minLength');
          --entry.minLength;
        }
      }
    }
  }

  // deliver every settled slot of `entry` to its call; `offset` is the index into
  // #calls of the first call fed by this entry. Returns the number of undelivered
  // slots remaining (all awaiting).
  #deliverSettledSlots(entry: InnerIterEntry, offset: number): number {
    let undelivered = 0;
    for (const slot of entry.slots) {
      if (slot.type === 'delivered') continue;
      if (slot.type === 'awaiting') {
        ++undelivered;
        continue;
      }
      const call = this.#calls.splice(offset + undelivered, 1)[0];
      ASSERT(call != null, 'every undelivered slot has a call');
      if (slot.type === 'value') {
        const { value } = slot;
        (slot as Slot).type = 'delivered';
        (slot as unknown as { value: unknown }).value = null; // for memory reasons
        call.resolve({ value, done: false });
      } else {
        ASSERT(slot.type === 'error', 'slot is settled');
        const errorSlot = slot as ErrorState;
        if (errorSlot.closeState === 'awaiting-return') {
          // the rejection is gated on a close; hand it the call's reject for when that settles
          (errorSlot as Extract<ErrorState, { closeState: 'awaiting-return' }>).reject = call.reject;
          (slot as Slot).type = 'delivered';
        } else {
          ASSERT(errorSlot.closeState === 'ready', 'closeState ready');
          const { error } = errorSlot;
          (slot as Slot).type = 'delivered';
          (slot as unknown as { error: unknown }).error = null; // for memory reasons
          call.reject(error);
        }
      }
    }
    return undelivered;
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
      this.#markSomeCallsAsNoLongerGettingValues(this.#calls.length - this.#valuesWeCouldDeliverFromClosedInnerIterators() - 1); // -1 for the slot we hold open in case of errors from the pull/mapper
      const { resolve, reject, promise } = Promise.withResolvers();
      this.#active = { type: 'draining', resolveReturn: resolve, rejectReturn: reject, errorSlot: null };
      return promise;
    }

    // TODO order of truncation vs resolving this Promise
    const active = this.#active as ActiveInnerIterState;
    this.#markUnderlyingAsFinished();
    this.#active = { type: 'finished' };
    return new Promise((res, rej) => {
      this.#closeInnerThenUnderlying(active.iter as MaybeReturnable, (gotError, error) => gotError ? rej(error) : res({ value: undefined, done: true }));
    });
  }
}

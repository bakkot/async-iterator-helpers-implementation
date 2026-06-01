export function flatMap(it, fn) {
  return new FlatMapHelper(it, fn);
}

function fastPromiseTry(cb) {
  try {
    return Promise.resolve(cb());
  } catch (e) {
    return Promise.reject(e);
  }
}

class FlatMapHelper {
  #it;
  #fn;

  /*
  type Slot =
    { type: 'awaiting' }
    { type: 'value', value: unknown }
    { type: 'error', error: unknown, closeState: CloseState }
    { type: 'removed' }

  type InFlight = { type: 'iter', iter: Iter, values: Slot[] }

  For errors from the mapper or from result iterators, we invoke underlying.return()
  This call must settle before the error is surfaced.

  type CloseState =
    | 'ready'      // no wait: no close, or the close has already settled
    | 'awaiting-return'   // close pending, error not yet at the head of the queue
    | ((e: Error) => void) // close pending, error committed to its call — invoke to reject it
  */

  // iterators which are
  #closedButStillHaveValuesInFlight = []; // InFlight[]

  /*
  type ActiveState =
    | null
    | { type: 'reading underlying', requested: N>0 }
    | { type: 'error', error: unkown, closeState: CloseState }
    | InFlight
  */
  #active = null; // ActiveState

  // we need this to tell us how many trailing { done: true }s to issue in case of error / finish in active iterator
  // invariant: calls.length == maxLive + [active.requested | active.values.length]
  // is this just the sum of the lengths of the values array?
  #maxLiveInClosedButStillHaveValuesInFlight = 0; // 0 iff #closedButStillHaveValuesInFlight.length === 0

  #calls = []; // { resolve, reject }

  // if this.#finished is true, this.#active is null
  // maybe fold them together? unstarted / reading underlying / active / error / finished ?
  #finished = false;
  
  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

  #issuePull(requested) {
    // assert: this.#active === null
    // (not actually because the re-pull from exhausting the active iterator doesn't first set it to null, but it could)
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }

    this.#active = { type: 'reading underlying', requested };

    fastPromiseTry(() => this.#it.next()).then(
      r => {
        if (this.#finished) return;

        fastPromiseTry(() => this.#fn(r)).then(
          iter => {
            if (this.#finished) return;

            // TODO handle sync iterators / iterables
            // TODO consider how to deal with distinguishing sync iterator from async iterator
            try {
              const actualIter = iter[Symbol.asyncIterator]();

              const values = [];
              this.#active = { type: 'iter', iter: actualIter, values };

              // ok, time to actually pull
              for (let i = 0; i < this.#active.requested; ++i) {
                // TODO worry about re-entrancy from calling .next() - probably is OK?

                const slot = { type: 'awaiting' };
                values.push(slot);

                fastPromiseTry(() => actualIter.next()).then(
                  iterResult => {
                    if (slot.type === 'removed') return;
                    // TODO
                    // when we get a done, remove it + all subsequent from values array
                  },
                  error => {
                    if (slot.type === 'removed') return;

                    if (this.#active.type === 'iter') {
                      if (this.#active.iter === actualIter) {
                        this.#closedButStillHaveValuesInFlight.push(this.#active);
                      } else {
                        // TODO close that one too
                      }
                      slot.type = 'error';
                      slot.error = error;
                      slot.closeState = 'awaiting-return';
                      this.#active = null;
                      this.closeUnderlyingForError(slot);
                    } else if (this.#active.type === 'reading underlying') {
                      const mightStillGetValues = Math.sumPrecise(this.#closedButStillHaveValuesInFlight.map(x => x.values.length));
                      for (let i = 0; i < this.#active.requested; ++i) {
                        this.#calls[mightStillGetValues + i].resolve({ done: true, value: undefined });
                      }
                      this.#active = null;
                    }
                    // TODO processQueue, if this error was at head
                  },
                );
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

        this.#finished = true;
        this.#active = { type: 'error', error, closeState: 'ready' };
        // TODO only do this if #maxLiveInClosedButStillHaveValuesInFlight === 0?
        this.#processQueue();
        return;
      }
    );
  }

  #closeUnderlyingForErrorInMapper(error) {
    // assert: this.#active.type === 'reading underlying'
    const slot = { type: 'error', error, closeState: 'awaiting-return' };
    this.#active = slot;
    this.#closeUnderlyingForError(slot);
  }

  #closeUnderlyingForError(slot) {
    this.#finished = true;
    // assert: slot.type === 'error'
    // assert: slot.closeState === 'awaiting-return';
    let returnPromise;
    try {
      returnPromise = this.#it?.return();
    } catch {
      // synchronous throw from it.return() gets swallowed
    }
    const onClosed = () => {
      if (typeof slot.closeState === 'function') {
        slot.closeState(err);
      } else {
        slot.closeState = 'ready';
      }
    };
    // TODO fast path for non-promise?
    Promise.resolve(returnPromise).then(onClosed, onClosed);

    // TODO if we're not invoking processQueue after calling this, we need to be able to handle the case that it's already the head here
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
    if (this.#active === null) {
      this.#issuePull(1);
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

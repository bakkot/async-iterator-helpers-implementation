import { fastPromiseTry, zalgo } from './util.ts';

export function filter(it: unknown, pred: unknown) {
  return new FilterHelper(it, pred);
}

type Nextable = { next: () => unknown };
type MaybeReturnable = { return?: () => unknown };

// For a predicate-error position, the it.return() close must settle before the
// error is surfaced; `closeState` tracks that wait:
//
//   'ready'                // no wait: no close, or the close has already settled
//   'awaiting-return'      // close pending, error not yet at the head of the queue
//   ((e: unknown) => void) // close pending, error committed to its call — invoke to reject it
type CloseState = 'ready' | 'awaiting-return' | ((e: unknown) => void);

type Slot =
  | { status: 'awaiting' }
  | { status: 'value'; value: unknown }
  | { status: 'error'; error: unknown; closeState: CloseState };

type Call = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

class FilterHelper {
  #it: unknown;
  #pred: unknown;

  // Slots is an ordered queue of results or placeholders for results.
  // Membership means "still live": a slot is in the Set from when its pull is issued
  // until it is delivered, dropped, or discarded by a terminal `done`.
  //
  // A dropped value, and a slot discarded by a terminal `done` wall, are both
  // deleted from the Set; a pull/predicate settlement that later arrives for a
  // discarded position finds it absent (#isIgnored) and is dropped on the floor.
  #slots = new Set<Slot>();

  #calls: Call[] = [];

  #finished = false;

  constructor(it: unknown, pred: unknown) {
    this.#it = it;
    this.#pred = pred;
  }

  #issuePull() {
    const pos = { status: 'awaiting' } as Slot;
    this.#slots.add(pos);
    const onError = (error: unknown) => {
      if (this.#isIgnored(pos)) return;
      pos.status = 'error';
      const errPos = pos as Extract<Slot, { status: 'error' }>;
      errPos.error = error;
      errPos.closeState = 'ready';
      this.#finished = true;
      if (this.#head() === pos) {
        this.#processQueue();
      }
    };
    fastPromiseTry(() => (this.#it as Nextable).next()).then(
      (r) => {
        if (this.#isIgnored(pos)) return;
        let done;
        let value;
        try {
          done = (r as { done: unknown }).done;
          if (!done) {
            value = (r as { value: unknown }).value;
          }
        } catch (error) {
          onError(error);
          return;
        }
        if (done) {
          // This is theoretically quadratic in the degree of concurrency: if we issue
          // N pulls and they all settle with { done: true } back-to-front, then
          // we will do N steps in this loop the first time, N-1 the second, etc.
          // In practice this is unlikely to matter.
          // A native implementation could probably avoid that cost.
          let discarding = false;
          for (const n of this.#slots) {
            if (n === pos) discarding = true;
            if (discarding) this.#slots.delete(n);
          }
          this.#finished = true;
          if (this.#head() === pos) {
            this.#processQueue();
          }
          const drained = this.#calls.splice(this.#slots.size);
          for (const call of drained) {
            call.resolve({ value: undefined, done: true });
          }
        } else {
          this.#invokePred(pos, value);
        }
      },
      onError,
    );
  }

  #invokePred(pos: Slot, value: unknown) {
    (pos as Extract<Slot, { status: 'value' }>).value = value;
    const onResult = (keep: unknown) => {
      if (this.#isIgnored(pos)) return;
      const isHead = this.#head() === pos;
      let needsReplacement = false;
      if (keep) {
        pos.status = 'value';
      } else {
        this.#slots.delete(pos);
        if (!this.#finished) {
          needsReplacement = true;
        } else {
          this.#calls.pop()!.resolve({ value: undefined, done: true });
        }
      }
      if (isHead) {
        this.#processQueue();
      }
      // we sequence this after draining queue to ensure the result Promises settle in a reasonable order even if the pull synchronously throws
      if (needsReplacement) {
        this.#issuePull();
      }
    };
    const onError = (err: unknown) => {
      if (this.#isIgnored(pos)) return;
      pos.status = 'error';
      const errPos = pos as Extract<Slot, { status: 'error' }>;
      errPos.error = err;
      const wasLive = !this.#finished;
      this.#finished = true;
      if (wasLive) {
        try {
          const returnMethod = (this.#it as MaybeReturnable).return;
          if (returnMethod == null) {
            errPos.closeState = 'ready';
          } else {
            const returnResult = returnMethod.call(this.#it);
            errPos.closeState = 'awaiting-return';
            const onClosed = () => {
              if (typeof errPos.closeState === 'function') errPos.closeState(err);
              else errPos.closeState = 'ready';
            };
            Promise.resolve(returnResult).then(onClosed, onClosed);
          }
        } catch {
          // synchronous throw from it.return() gets swallowed
          errPos.closeState = 'ready';
        }
      }
      if (this.#head() === pos) {
        this.#processQueue();
      }
    };

    let result;
    try {
      result = (this.#pred as (v: unknown) => unknown)(value);
    } catch (error) {
      onError(error);
      return;
    }
    zalgo(result, onResult, onError);
  }

  #processQueue() {
    while (this.#calls.length > 0 && this.#slots.size > 0) {
      const pos = this.#head()!;
      if (pos.status === 'value') {
        this.#slots.delete(pos);
        this.#calls.shift()!.resolve({ value: pos.value, done: false });
      } else if (pos.status === 'error') {
        this.#slots.delete(pos);
        const call = this.#calls.shift()!;
        if (pos.closeState === 'awaiting-return') {
          // This error triggered `#it.return()`, and the result has not yet settled.
          // Since this is the head of the queue, we can commit it to this call by leaving a rejector for
          // the close reaction to invoke, and can still drop `pos` from `#positions`.
          pos.closeState = call.reject;
        } else {
          // assert: pos.closeState === 'ready'
          call.reject(pos.error);
        }
      } else {
        // assert: pos.status === 'awaiting'
        break;
      }
    }
  }

  #head(): Slot | undefined {
    return this.#slots.values().next().value;
  }

  // A settlement is stale if its position is no longer in the queue, which can
  // only mean a terminal `done` wall discarded it.
  #isIgnored(pos: Slot) {
    return !this.#slots.has(pos);
  }

  // ---- consumer-facing iterator ----------------------------------------

  next() {
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    const { resolve, reject, promise } = Promise.withResolvers();
    this.#calls.push({ resolve, reject });
    this.#issuePull();

    return promise;
  }

  return() {
    if (this.#finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    this.#finished = true;

    try {
      const ret = (this.#it as MaybeReturnable).return;
      if (ret == null) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return Promise.resolve(ret.call(this.#it)).then(() => ({ value: undefined, done: true }));
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

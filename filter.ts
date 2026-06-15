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
    let result: unknown;
    try {
      result = (this.#it as Nextable).next();
    } catch (e) {
      // TODO reconsider whether this really needs to happen same-tick
      // we could instead fold it into the rejection case
      pos.status = 'error';
      const errPos = pos as Extract<Slot, { status: 'error' }>;
      errPos.error = e;
      errPos.closeState = 'ready';
      this.#finished = true;
      // source faulted so we do not call it.return().
      if (this.#calls.length === 1) {
        // i.e. this is the only thing in the queue
        this.#processQueue();
      }
      return;
    }

    Promise.resolve(result).then(
      (r) => {
        if (this.#isIgnored(pos)) return;
        // TODO handle errors from reading `done`/`value` properties
        if ((r as { done: unknown }).done) {
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
          this.#invokePred(pos, (r as { value: unknown }).value);
        }
      },
      (e) => {
        if (this.#isIgnored(pos)) return;
        pos.status = 'error';
        const errPos = pos as Extract<Slot, { status: 'error' }>;
        errPos.error = e;
        errPos.closeState = 'ready';
        this.#finished = true;
        if (this.#head() === pos) {
          this.#processQueue();
        }
      }
    );
  }

  #invokePred(pos: Slot, value: unknown) {
    (pos as Extract<Slot, { status: 'value' }>).value = value;
    // TODO reconsider: maybe we shouldn't have to pay a microtask tick if the
    // predicate synchronously returns true or false.
    let res: unknown;
    try {
      res = (this.#pred as (v: unknown) => unknown)(value);
    } catch (e) {
      res = Promise.reject(e);
    }
    Promise.resolve(res).then(
      (keep) => {
        if (this.#isIgnored(pos)) return;
        const isHead = this.#head() === pos;
        if (keep) {
          pos.status = 'value';
        } else {
          this.#slots.delete(pos);
          if (!this.#finished) {
            this.#issuePull();
          } else {
            this.#calls.pop()!.resolve({ value: undefined, done: true });
          }
        }
        if (isHead) {
          this.#processQueue();
        }
      },
      (err) => {
        if (this.#isIgnored(pos)) return;
        pos.status = 'error';
        const errPos = pos as Extract<Slot, { status: 'error' }>;
        errPos.error = err;
        const wasLive = !this.#finished;
        this.#finished = true;
        if (wasLive) {
          let r: unknown;
          try {
            r = (this.#it as MaybeReturnable).return?.();
          } catch {
            // synchronous throw from it.return() gets swallowed
          }
          // TODO Promise.resolve? if not, handle errors from .then
          if (r && typeof (r as { then?: unknown }).then === 'function') {
            errPos.closeState = 'awaiting-return';
            const onClosed = () => {
              if (typeof errPos.closeState === 'function') errPos.closeState(err);
              else errPos.closeState = 'ready';
            };
            (r as PromiseLike<unknown>).then(onClosed, onClosed);
          } else {
            errPos.closeState = 'ready';
          }
        }
        if (this.#head() === pos) {
          this.#processQueue();
        }
      }
    );
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

    let r: unknown;
    try {
      r = (this.#it as MaybeReturnable).return?.();
    } catch (e) {
      return Promise.reject(e);
    }

    return Promise.resolve(r).then(() => ({ value: undefined, done: true }));
  }
}

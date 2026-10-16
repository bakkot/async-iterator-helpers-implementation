import { fastPromiseTry, zalgo } from './util.ts';

export function map(it: unknown, fn: unknown) {
  return new MapHelper(it, fn);
}

type Iterator = {
  next: () => unknown,
  return?: () => unknown,
};

class MapHelper {
  #done = false;
  #pullsIssued = 0;
  // the index of the latest pull which settled with something other than { done: true }
  #latestNonDonePull = -1;
  #it: Iterator;
  #fn: (v: unknown) => unknown;
  constructor(it: unknown, fn: unknown) {
    this.#it = it as Iterator;
    this.#fn = fn as (v: unknown) => unknown;
  }

  next() {
    if (this.#done) {
      return Promise.resolve({ done: true, value: undefined });
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const index = this.#pullsIssued++;
    fastPromiseTry(() => this.#it.next()).then(result => {
      let value;
      try {
        if ((result as { done: unknown }).done) {
          this.#done = true;
          if (this.#latestNonDonePull > index) {
            // the later result has already been given a position (and possibly delivered), so the iterator is incoherent
            reject(new TypeError('underlying iterator returned { done: true } after a later pull already settled'));
          } else {
            resolve({ value: undefined, done: true });
          }
          return;
        }
        this.#latestNonDonePull = Math.max(this.#latestNonDonePull, index);
        value = (result as { value: unknown }).value;
      } catch (error) {
        // errors from reading .done or .value
        this.#latestNonDonePull = Math.max(this.#latestNonDonePull, index);
        this.#done = true;
        reject(error);
        return;
      }
      const onError = (error: unknown) => {
        if (this.#done) {
          reject(error);
          return;
        }
        this.#done = true;
        try {
          const ret = this.#it.return;
          if (ret == null) {
            reject(error);
            return;
          }
          // we use Promise.resolve instead of fastPromiseTry so sync errors don't incur extra ticks
          // we use `.then` instead of `.finally` because it adds extra ticks for some reason
          Promise.resolve((ret as () => unknown).call(this.#it)).then(() => reject(error), () => reject(error));
        } catch {
          reject(error);
        }
      };
      let mapped;
      try {
        mapped = this.#fn(value);
      } catch (error) {
        onError(error);
        return;
      }
      // TODO SafePromiseResolve, here and possibly elsewhere
      zalgo(mapped, mapped => resolve({ value: mapped, done: false }), onError);
    }, (error) => {
      // errors from `.next()`
      this.#latestNonDonePull = Math.max(this.#latestNonDonePull, index);
      this.#done = true;
      reject(error);
    });
    return promise;
  }

  return() {
    if (this.#done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    this.#done = true;
    try {
      const ret = this.#it.return;
      if (ret == null) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return Promise.resolve(ret.call(this.#it)).then(() => ({ value: undefined, done: true }));
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

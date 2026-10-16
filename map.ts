import { fastPromiseTry } from './util.ts';

export function map(it: unknown, fn: unknown) {
  return new MapHelper(it, fn);
}

type Iterator = {
  next: () => unknown,
  return?: () => unknown,
};

class MapHelper {
  #done = false;
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
    fastPromiseTry(() => this.#it.next()).then(result => {
      let value;
      try {
        if ((result as { done: unknown }).done) {
          this.#done = true;
          resolve({ value: undefined, done: true });
          return;
        }
        value = (result as { value: unknown }).value;
      } catch (error) {
        // errors from reading .done or .value
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
      fastPromiseTry(() => this.#fn(value)).then(mapped => resolve({ value: mapped, done: false }), onError);
    }, (error) => {
      // errors from `.next()`
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

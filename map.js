export function map(it, fn) {
  return new MapHelper(it, fn);
}

class MapHelper {
  #done = false;
  #it;
  #fn;
  constructor(it, fn) {
    this.#it = it;
    this.#fn = fn;
  }

  next() {
    if (this.#done) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return (new Promise(resolve => resolve(this.#it.next()))).then(({ value, done }) => {
      if (done) {
        this.#done = true;
        return { value, done }; // TODO think about `value: undefined`` here
      }
      return (new Promise(res => res(this.#fn(value)))).then(mapped => {
        return { value: mapped, done: false,  };
      }, (err) => {
        // An error from the predicate closes the underlying iterator, but only
        // if the machinery is still live. If we're already done — a concurrent
        // call closed it, return() ran, or the underlying itself errored or
        // finished — leave the underlying alone (in particular, never call
        // .return() after observing an error from the underlying).
        if (this.#done) {
          return Promise.reject(err);
        }
        this.#done = true;
        // errors from calling .return() are swallowed, as in IteratorClose,
        // whether .return() throws synchronously or returns a rejected promise
        try {
          return Promise.resolve(this.#it?.return()).finally(() => Promise.reject(err));
        } catch {
          return Promise.reject(err);
        }
      })
    }).catch((err) => {
      // this handles sync and async errors from `.next()` as well as errors from destructuring the result object
      this.#done = true;
      throw err;
    });
  }

  async return() {
    if (this.#done) {
      return { value: undefined, done: true };
    }
    this.#done = true;
    await this.#it?.return();
    return { value: undefined, done: true };
  }
}

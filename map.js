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
    let pull;
    try {
      pull = this.#it.next();
    } catch (err) {
      // a synchronous throw from the underlying .next() is an error *from* the
      // underlying iterator: surface it as a rejection without closing it
      this.#done = true;
      return Promise.reject(err);
    }
    return Promise.resolve(pull).then(({ value, done }) => {
      if (done) {
        this.#done = true;
        return { value, done }; // TODO think about `value: undefined`` here
      }
      return (new Promise(res => res(this.#fn(value)))).then(mapped => {
        return { value: mapped, done: false,  };
      }, (err) => {
        // errors from the predicate function close the underlying iterator
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
      // we use .catch rather than the second argument to .then so that errors from destructuring the result object are still handled
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

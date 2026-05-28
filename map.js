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
      return { done: true, value: undefined };
    }
    return Promise.resolve(this.#it.next()).then(({ value, done }) => {
      if (done) {
        this.#done = true;
        return { value, done }; // TODO think about `value: undefined`` here
      }
      return (new Promise(res => res(this.#fn(value)))).then(mapped => {
        return { value: mapped, done: false,  };
      }, (err) => {
        // errors from the predicate function close the underlying iterator
        this.#done = true;
        // errors from calling .return() are swallowed, as in IteratorClose
        return Promise.resolve(this.#it?.return()).finally(() => Promise.reject(err));
      })
    }).catch((err) => {
      // we use .catch rather than the second argument to .then so that errors from the mapper and from destructuring the result object are still handled
      this.#done = true;
      throw err;
    });
  }

  async return() {
    if (this.#done) {
      return {};
    }
    this.#done = true;
    await this.#it?.return();
    return {};
  }
}

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
        return { value: undefined, done: true };
      }
      return (new Promise(res => res(this.#fn(value)))).then(mapped => {
        return { value: mapped, done: false,  };
      }, (err) => {
        if (this.#done) {
          return Promise.reject(err);
        }
        this.#done = true;
        try {
          return Promise.resolve(this.#it.return?.()).finally(() => Promise.reject(err));
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
    await this.#it.return?.();
    return { value: undefined, done: true };
  }
}

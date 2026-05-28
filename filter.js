export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

class FilterHelper {
  #done = false;
  #it;
  #pred;
  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

  next() {
    // TODO
    return Promise.resolve({ done: true, value: undefined });
  }

  return() {
    // TODO
    return Promise.resolve({ done: true, value: undefined });
  }
}
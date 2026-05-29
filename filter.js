export function filter(it, pred) {
  return new FilterHelper(it, pred);
}

class FilterHelper {
  #done = false;
  #it;
  #pred;

  // The helper keeps a retained sequence of issued underlying pulls. Each
  // consumer receives the next node in that sequence whose predicate passes;
  // dropped nodes are deleted and replaced with another pull while the source
  // is still live.
  //
  // Once #done is set, no replacement pulls will be issued. At that point
  // #valueLimit is a ceiling on how many waiting consumers can still receive
  // values/errors from the remaining list, so consumers beyond it can resolve
  // done immediately even if earlier nodes are still pending.
  //
  // Core invariants:
  // - #terminalIndex is null while live. Once terminal, completions with a
  //   higher index are ignored.
  // - #valueLimit counts retained nodes that can still consume one caller:
  //   'pending', 'value', and 'error'. It excludes the terminal 'done' wall.
  // - 0 <= #valueLimit <= retained node count.
  //
  // Node =
  //   | { status: 'pending' | 'done', index: number, prev: Node?, next: Node? }
  //   | { status: 'value', value: unknown, index: number, prev: Node?, next: Node? }
  //   | { status: 'error', error: unknown, index: number, prev: Node?, next: Node? }
  #head = null;
  #tail = null;
  #nextIndex = 0;
  #terminalIndex = null;
  // Waiting consumer deferreds, in call order.
  #consumers = [];
  // Kept current so terminal done-settlement never scans the retained list.
  #valueLimit = 0;

  constructor(it, pred) {
    this.#it = it;
    this.#pred = pred;
  }

  next() {
    if (this.#done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    const d = Promise.withResolvers();
    this.#consumers.push(d);
    this.#pull();
    return d.promise;
  }

  async return() {
    if (this.#done) {
      return { value: undefined, done: true };
    }
    this.#done = true;
    await this.#it?.return();
    return { value: undefined, done: true };
  }

  // Issue one underlying pull. Called once per consumer call and once more per
  // dropped value (to replace it), but never once we're done.
  #pull() {
    const node = {
      status: 'pending',
      index: this.#nextIndex++,
      prev: null,
      next: null,
    };
    if (this.#tail) {
      node.prev = this.#tail;
      this.#tail.next = node;
    } else {
      this.#head = node;
    }
    this.#tail = node;
    this.#valueLimit++;
    new Promise(resolve => resolve(this.#it.next())).then(settled => {
      if (this.#isIgnored(node)) return;
      let value, done;
      try {
        ({ value, done } = settled);
      } catch (err) {
        // A throwing result object is an error *from* the underlying: surface
        // it, but never close.
        this.#done = true;
        this.#terminalIndex ??= this.#nextIndex - 1;
        this.#fail(node, err);
        return;
      }
      if (done) {
        // Clean exhaustion: done, but the underlying is not closed.
        this.#done = true;
        this.#terminalIndex = node.index;
        node.status = 'done';
        this.#valueLimit--;
        for (let n = node.next; n;) {
          const next = n.next;
          this.#valueLimit--;
          // Truncated nodes may still be held by pending pull completions; cut
          // their list links so ignored work does not retain live values.
          n.prev = null;
          n.next = null;
          n = next;
        }
        this.#tail = node;
        node.next = null;
        this.#pump();
        if (this.#consumers.length > this.#valueLimit) {
          for (let i = this.#valueLimit; i < this.#consumers.length; i++) {
            this.#consumers[i].resolve({ value: undefined, done: true });
          }
          this.#consumers.length = this.#valueLimit;
          if (this.#consumers.length === 0) {
            this.#clearTerminalState();
          }
        }
        return;
      }
      new Promise(resolve => resolve(this.#pred(value))).then(keep => {
        if (this.#isIgnored(node)) return;
        if (keep) {
          node.status = 'value';
          node.value = value;
          this.#pump();
        } else {
          // A dropped value is deleted from the retained sequence.
          let wasHead = false;
          const predecessor = node.prev;
          const successor = node.next;
          if (predecessor) {
            predecessor.next = successor;
          } else {
            wasHead = true;
            this.#head = successor;
          }
          if (successor) {
            successor.prev = predecessor;
          } else {
            this.#tail = predecessor;
          }
          this.#valueLimit--;
          if (!this.#done) this.#pull();
          if (wasHead && successor) this.#pump();
          if (this.#done && this.#consumers.length > this.#valueLimit) {
            this.#consumers[this.#valueLimit].resolve({ value: undefined, done: true });
            this.#consumers.length = this.#valueLimit;
            if (this.#consumers.length === 0) {
              this.#clearTerminalState();
            }
          }
        }
      }, err => {
        if (this.#isIgnored(node)) return;
        // A predicate error is treated like `true` (the value still fills its
        // position) except that position rejects, future next() calls get done,
        // and the underlying is closed — the last only if still live.
        if (!this.#done) {
          this.#done = true;
          this.#terminalIndex = this.#nextIndex - 1;
          this.#close();
        }
        this.#fail(node, err);
      });
    }, err => {
      if (this.#isIgnored(node)) return;
      // Error from the underlying's .next(): surface it, but never close.
      this.#done = true;
      this.#terminalIndex ??= this.#nextIndex - 1;
      this.#fail(node, err);
    });
  }

  // Deliver settled nodes to waiting consumers in order.
  #pump() {
    while (this.#consumers.length > 0) {
      const node = this.#head;
      if (node.status === 'pending') break;

      switch (node.status) {
        case 'value':
          this.#consumers.shift().resolve({ value: node.value, done: false });
          break;
        case 'done':
          // A done wall at the head means no retained node can still produce a
          // value, so every waiting consumer is done.
          for (const consumer of this.#consumers) {
            consumer.resolve({ value: undefined, done: true });
          }
          this.#consumers.length = 0;
          this.#clearTerminalState();
          return;
        case 'error':
          // 'error': like a value, but the call at this position rejects. It
          // does not end the others — they keep being served — so advance and
          // continue.
          this.#consumers.shift().reject(node.error);
          break;
      }

      this.#head = node.next;
      if (this.#head) {
        this.#head.prev = null;
      } else {
        this.#tail = null;
      }
      this.#valueLimit--;
    }
  }

  #clearTerminalState() {
    // No node can become observable after terminal drain; drop references
    // eagerly while allowing already-issued pulls to finish harmlessly.
    this.#head = null;
    this.#tail = null;
    this.#valueLimit = 0;
    this.#terminalIndex = -1;
  }

  // Record an error at a node: it keeps its value-position and is rejected in
  // order by #pump. An error does not exhaust the source the way a done does, so
  // the pulls already in flight still serve their calls (values are not lost);
  // but no new pull will happen, so #done lets any call that would need one
  // settle done instead of hanging.
  #fail(node, err) {
    node.status = 'error';
    node.error = err;
    this.#pump();
  }

  #isIgnored(node) {
    return this.#terminalIndex !== null && node.index > this.#terminalIndex;
  }

  #close() {
    try {
      // errors from .return() are swallowed, as in IteratorClose
      Promise.resolve(this.#it?.return()).then(undefined, () => {});
    } catch {}
  }
}

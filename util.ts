// https://github.com/tc39/ecma262/pull/3883
export function fastPromiseTry<T>(cb: () => T): Promise<Awaited<T>> {
  try {
    return Promise.resolve(cb());
  } catch (e) {
    return Promise.reject(e);
  }
}

// like PromiseResolve(%Promise%, resolution), except that it returns null (~empty~) when resolution is not a thenable
export function PromiseResolveIfThenable(resolution: unknown): Promise<unknown> | null {
  if (resolution == null || (typeof resolution !== 'object' && typeof resolution !== 'function')) {
    return null;
  }

  // ideally we'd do the IsPromise fast path here, before reading `.then`

  const then = (resolution as { then: unknown }).then;
  if (typeof then !== 'function') {
    return null;
  }

  // "then === Promise.prototype.then" is standing in for IsPromise
  if (then === Promise.prototype.then) {
    if ((resolution as { constructor: unknown }).constructor === Promise) {
      return resolution as Promise<unknown>;
    }
  }

  const { resolve, reject, promise } = Promise.withResolvers();

  // actual invocation of .then happens next tick, as in PromiseResolve -> NewPromiseResolveThenableJob
  Promise.resolve().then(() => {
    try {
      then.call(resolution, resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
  return promise;
}

// if `value` is thenable, do PromiseResolve(value).then(continuation)
// if not, do `continuation(value)`
// contract: `continuation` must not throw or reject
export function zalgo<R>(
  value: unknown,
  continuation: (value: unknown) => R,
  onError: (error: unknown) => unknown,
) {
  try {
    const promise = PromiseResolveIfThenable(value);
    if (promise === null) {
      return continuation(value);
    }
    // should be PerformPromiseThen
    return Promise.prototype.then.call(promise, continuation, onError);
  } catch (error) {
    return onError(error);
  }
}

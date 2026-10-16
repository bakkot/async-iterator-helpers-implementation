import { fastPromiseTry, PromiseResolveIfThenable, zalgo } from '../util.ts';
import { runTests } from './utils.js';

const tests = [];

tests.push(['fastPromiseTry: invokes synchronously and adopts its result', async function (t) {
  let called = false;
  const expected = Promise.resolve(1);
  const actual = fastPromiseTry(() => {
    called = true;
    return expected;
  });

  t.check('callback is invoked synchronously', called, true);
  t.check('native promise is returned unchanged', actual === expected, true);
}]);

tests.push(['fastPromiseTry: converts a synchronous throw to a rejection', async function (t) {
  const expected = new Error('boom');
  let promise;
  try {
    promise = fastPromiseTry(() => { throw expected; });
  } catch {
    t.check('call does not throw synchronously', true, false);
    return;
  }

  let actual;
  try {
    await promise;
  } catch (error) {
    actual = error;
  }
  t.check('promise rejects with the original error', actual === expected, true);
}]);

tests.push(['PromiseResolveIfThenable: non-thenables return null after one then read', async function (t) {
  let thenReads = 0;
  const object = {};
  Object.defineProperty(object, 'then', {
    get() {
      thenReads++;
      return undefined;
    },
  });

  t.check('primitive is not a thenable', PromiseResolveIfThenable(0), null);
  t.check('object is not a thenable', PromiseResolveIfThenable(object), null);
  t.check('function is not a thenable', PromiseResolveIfThenable(() => {}), null);
  t.check('then is read once', thenReads, 1);
}]);

tests.push(['PromiseResolveIfThenable: native promise fast path and queued thenable call', async function (t) {
  const nativePromise = Promise.resolve(1);
  t.check('native promise is returned unchanged', PromiseResolveIfThenable(nativePromise) === nativePromise, true);

  class PromiseSubclass extends Promise {}
  const subclassPromise = PromiseSubclass.resolve(2);
  const adoptedSubclassPromise = PromiseResolveIfThenable(subclassPromise);
  t.check('subclass promise is adopted into a new promise', adoptedSubclassPromise === subclassPromise, false);
  t.check('subclass promise value is preserved', await adoptedSubclassPromise, 2);

  let synchronous = true;
  let thenReads = 0;
  let calledSynchronously;
  const thenable = {};
  Object.defineProperty(thenable, 'then', {
    get() {
      thenReads++;
      return resolve => {
        calledSynchronously = synchronous;
        resolve(2);
      };
    },
  });

  const promise = PromiseResolveIfThenable(thenable);
  synchronous = false;
  t.check('then is read once', thenReads, 1);
  t.check('then has not yet been called', calledSynchronously, undefined);
  t.check('thenable resolves', await promise, 2);
  t.check('then is called in a promise job', calledSynchronously, false);
}]);

tests.push(['PromiseResolveIfThenable: a throwing then getter throws synchronously', async function (t) {
  const expected = new Error('boom');
  let actual;
  try {
    PromiseResolveIfThenable({ get then() { throw expected; } });
  } catch (error) {
    actual = error;
  }
  t.check('original error is thrown', actual === expected, true);
}]);

tests.push(['PromiseResolveIfThenable: arbitrary thenables use normal assimilation rules', async function (t) {
  let thenReads = 0;
  const inner = { then(resolve) { resolve(42); } };
  const outer = {};
  Object.defineProperty(outer, 'then', {
    get() {
      thenReads++;
      return (resolve, reject) => {
        resolve(inner);
        reject(new Error('too late'));
        throw new Error('also too late');
      };
    },
  });

  t.check('first settlement is recursively assimilated', await PromiseResolveIfThenable(outer), 42);
  t.check('then is read once', thenReads, 1);
}]);

tests.push(['zalgo: non-thenables invoke the continuation synchronously', async function (t) {
  const value = {};
  let synchronous = true;
  let calledSynchronously;
  const result = zalgo(value, mapped => {
    calledSynchronously = synchronous;
    return { mapped };
  }, () => {
    throw new Error('unexpected error');
  });
  synchronous = false;

  t.check('continuation is synchronous', calledSynchronously, true);
  t.check('continuation result is returned directly', result, { mapped: value });
}]);

tests.push(['zalgo: synchronous inspection errors use the synchronous error path', async function (t) {
  const expected = new Error('boom');
  let synchronous = true;
  let calledSynchronously;
  let actual;
  const result = zalgo({ get then() { throw expected; } }, () => {
    throw new Error('unexpected continuation');
  }, error => {
    calledSynchronously = synchronous;
    actual = error;
    return 'handled';
  });
  synchronous = false;

  t.check('error handler is synchronous', calledSynchronously, true);
  t.check('original error reaches error handler', actual === expected, true);
  t.check('error handler result is returned directly', result, 'handled');
}]);

await runTests(tests);

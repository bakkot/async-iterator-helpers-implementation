import { fastPromiseTry } from '../util.ts';
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

await runTests(tests);

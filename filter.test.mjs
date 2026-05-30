import filter from './filter.js';

function deferred() {
  let r, j;
  const p = new Promise((a, b) => { r = a; j = b; });
  return { p, resolve: r, reject: j };
}

// A controllable source. Every it.next() pull is recorded in order with its
// own deferred, so a test can settle the i-th pull precisely (by pull index).
function makeSource() {
  const pulls = []; // one deferred per it.next() call, in pull order
  const log = [];
  const it = {
    next() {
      log.push('next');
      const d = deferred();
      pulls.push(d);
      return d.p;
    },
    return(v) { log.push('return'); return Promise.resolve({ value: v, done: true }); },
  };
  return {
    it, log, pulls,
    pullCount: () => pulls.length,
    value: (i, v) => pulls[i].resolve({ value: v, done: false }),
    done: (i) => pulls[i].resolve({ value: undefined, done: true }),
    err: (i, e) => pulls[i].reject(e),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let passed = 0;
function ok(cond, msg, ...extra) {
  if (!cond) {
    console.error('FAIL:', msg, ...extra);
    process.exitCode = 1;
  } else {
    passed++;
  }
}

async function test_basic_sequential() {
  const s = makeSource();
  const f = filter(s.it, (x) => x % 2 === 0);
  const p0 = f.next();        // pull 0
  s.value(0, 1);              // dropped (odd) -> replacement pull 1
  await tick();
  s.value(1, 2);              // kept by replacement
  const r0 = await p0;
  ok(r0.value === 2 && r0.done === false, 'basic_sequential', r0);
}

async function test_concurrent_order() {
  // Two concurrent calls; the later position's value becomes known first but
  // must still be delivered after the earlier call.
  const s = makeSource();
  const f = filter(s.it, async (x) => x !== 'drop');
  const p0 = f.next();        // pull 0
  const p1 = f.next();        // pull 1
  await tick();
  s.value(0, 'drop');         // P0 drops -> replacement pull 2 (in P0's place)
  await tick();
  s.value(1, 'B');            // P1's value becomes known first
  await tick();
  s.value(2, 'A');            // replacement value
  const [r0, r1] = await Promise.all([p0, p1]);
  ok(r0.value === 'A' && r1.value === 'B', 'concurrent_order', r0, r1);
}

async function test_done_ceiling_with_values() {
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next(), p1 = f.next(), p2 = f.next(); // pulls 0,1,2
  await tick();
  s.value(0, 'a'); s.value(1, 'b'); s.done(2);
  const r = await Promise.all([p0, p1, p2]);
  ok(r[0].value === 'a' && r[1].value === 'b' && r[2].done === true,
    'done_ceiling_with_values', r);
}

async function test_done_releases_all_when_wall_at_head() {
  // done lands on the first position -> wall at head, V=0, every call done.
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next(), p1 = f.next(), p2 = f.next();
  await tick();
  s.done(0);
  const r = await Promise.all([p0, p1, p2]);
  ok(r.every((x) => x.done === true), 'done_all_trailing', r);
}

async function test_done_ceiling_trailing_only() {
  // P0, P1 pending; P2 done. C2 must settle done immediately while C0/C1 wait.
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next(), p1 = f.next(), p2 = f.next();
  await tick();
  s.done(2); // third pull done; first two still pending
  const r2 = await p2;
  ok(r2.done === true, 'done_ceiling_trailing_only p2 done early', r2);
  // p0, p1 still served by their own pulls afterward.
  s.value(0, 'a'); s.value(1, 'b');
  const [r0, r1] = await Promise.all([p0, p1]);
  ok(r0.value === 'a' && r1.value === 'b', 'done_ceiling_trailing_only earlier values', r0, r1);
}

async function test_error_positional() {
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next(), p1 = f.next(); // pulls 0,1
  await tick();
  s.err(0, new Error('boom')); // P0 error
  s.value(1, 'B');             // P1 value still delivered
  let e0;
  try { await p0; } catch (e) { e0 = e; }
  const r1 = await p1;
  ok(e0 && e0.message === 'boom' && r1.value === 'B', 'error_positional', e0, r1);
}

async function test_error_compacts_on_drop() {
  // [P0 pending, P1 error]; P0 then drops -> error compacts to C0, C1 -> done.
  const s = makeSource();
  const f = filter(s.it, (x) => x !== 'drop');
  const p0 = f.next(), p1 = f.next(); // pulls 0,1
  await tick();
  s.err(1, new Error('boom')); // P1 errors first -> finished, but waits behind P0
  await tick();
  s.value(0, 'drop');          // P0 drops; finished so no replacement -> error compacts
  let e0, r1;
  try { await p0; } catch (e) { e0 = e; }
  r1 = await p1;
  ok(e0 && e0.message === 'boom', 'error_compacts_on_drop rejects C0', e0);
  ok(r1.done === true, 'error_compacts_on_drop C1 done', r1);
}

async function test_return_closes_once() {
  const s = makeSource();
  const f = filter(s.it, () => true);
  const r = await f.return(42);
  ok(r.done === true && r.value === 42, 'return value', r);
  ok(s.log.filter((x) => x === 'return').length === 1, 'return called once', s.log);
  const r2 = await f.next();
  ok(r2.done === true, 'next after return', r2);
  const r3 = await f.return(7);
  ok(r3.done === true && s.log.filter((x) => x === 'return').length === 1,
    'second return does not re-close', s.log);
}

async function test_return_keeps_inflight() {
  // A call already outstanding keeps its pull; a passing value is delivered.
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next();
  await tick();
  const rp = f.return();
  s.value(0, 'X'); // in-flight pull still delivers to C0
  const r0 = await p0;
  ok(r0.value === 'X', 'return keeps inflight value', r0);
  ok((await rp).done === true, 'return resolves done');
}

async function test_return_drop_settles_done() {
  // Outstanding call whose position drops after return() -> done (no hang).
  const s = makeSource();
  const f = filter(s.it, (x) => x !== 'drop');
  const p0 = f.next();
  await tick();
  const rp = f.return();
  s.value(0, 'drop'); // position drops; finished -> cannot replace -> done
  const r0 = await p0;
  ok(r0.done === true, 'return drop settles done', r0);
  await rp;
}

async function test_pred_error_closes_source() {
  const s = makeSource();
  const f = filter(s.it, () => { throw new Error('pred'); });
  const p0 = f.next();
  s.value(0, 1);
  let e;
  try { await p0; } catch (err) { e = err; }
  ok(e && e.message === 'pred', 'pred_error rejects', e);
  await tick();
  ok(s.log.includes('return'), 'pred_error closes source', s.log);
}

async function test_source_error_no_close() {
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next();
  s.err(0, new Error('src'));
  let e;
  try { await p0; } catch (err) { e = err; }
  ok(e && e.message === 'src', 'source_error rejects', e);
  await tick();
  ok(!s.log.includes('return'), 'source_error does not close source', s.log);
}

async function test_done_no_close() {
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next();
  s.done(0);
  const r0 = await p0;
  ok(r0.done === true, 'done settles done', r0);
  await tick();
  ok(!s.log.includes('return'), 'clean done does not close source', s.log);
}

async function test_one_pull_per_next() {
  const s = makeSource();
  const f = filter(s.it, () => true);
  f.next(); f.next(); f.next();
  await tick();
  ok(s.log.filter((x) => x === 'next').length === 3, 'one pull per next', s.log);
}

async function test_sync_throw_next() {
  const it = { next() { throw new Error('sync'); }, return() { return Promise.resolve({ done: true }); } };
  const f = filter(it, () => true);
  let e;
  try { await f.next(); } catch (err) { e = err; }
  ok(e && e.message === 'sync', 'sync throw from it.next()', e);
}

const tests = [
  test_basic_sequential,
  test_concurrent_order,
  test_done_ceiling_with_values,
  test_done_releases_all_when_wall_at_head,
  test_done_ceiling_trailing_only,
  test_error_positional,
  test_error_compacts_on_drop,
  test_return_closes_once,
  test_return_keeps_inflight,
  test_return_drop_settles_done,
  test_pred_error_closes_source,
  test_source_error_no_close,
  test_done_no_close,
  test_one_pull_per_next,
  test_sync_throw_next,
];

for (const t of tests) {
  await t();
}
console.log(`done: ${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}`);

// --- additional subtle cases ---------------------------------------------

async function test_done_overrides_later_error() {
  // P0 done, P1 already errored -> done at the earlier position discards and
  // suppresses the later speculative error. C0 done, C1 done (beyond ceiling).
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next(), p1 = f.next();
  await tick();
  s.err(1, new Error('speculative')); // P1 errors first -> finished
  await tick();
  s.done(0);                          // earlier done overrides
  const r0 = await p0;
  const r1 = await p1;
  ok(r0.done === true, 'done_overrides p0 done', r0);
  ok(r1.done === true, 'done_overrides p1 done (error suppressed)', r1);
}

async function test_ceiling_lowers_on_drop_after_done() {
  // 4 calls. P3 done. Then P1 drops -> releases one more trailing call to done.
  // C0,C1 served by P0,P2; C2,C3 done.
  const s = makeSource();
  const f = filter(s.it, (x) => x !== 'drop');
  const p0 = f.next(), p1 = f.next(), p2 = f.next(), p3 = f.next();
  await tick();
  s.done(3);            // V=3 (P0,P1,P2), R=4 -> C3 done
  const r3 = await p3;
  ok(r3.done === true, 'ceiling p3 done', r3);
  s.value(1, 'drop');   // P1 drops; finished -> V=2 -> C2 done
  const r2 = await p2;
  ok(r2.done === true, 'ceiling p2 done after drop', r2);
  s.value(0, 'a');      // P0 -> C0
  s.value(2, 'c');      // P2 -> C1
  const [r0, r1] = await Promise.all([p0, p1]);
  ok(r0.value === 'a' && r1.value === 'c', 'ceiling earlier values', r0, r1);
}

async function test_value_before_later_error() {
  // earlier value is delivered before a later error reaches its call
  const s = makeSource();
  const f = filter(s.it, () => true);
  const p0 = f.next(), p1 = f.next();
  await tick();
  s.err(1, new Error('boom')); // P1 error known first
  s.value(0, 'A');             // P0 value delivered first
  const r0 = await p0;
  let e1;
  try { await p1; } catch (e) { e1 = e; }
  ok(r0.value === 'A' && e1 && e1.message === 'boom', 'value_before_later_error', r0, e1);
}

async function test_async_pred_drop_replacement() {
  // async predicate; first value dropped, replacement kept
  const s = makeSource();
  const f = filter(s.it, async (x) => x > 10);
  const p0 = f.next();
  s.value(0, 5);   // pull 0 -> async pred -> drop -> replacement pull 1
  await tick(); await tick();
  ok(s.pullCount() === 2, 'async_pred replacement pull issued', s.pullCount());
  s.value(1, 20);  // kept
  const r0 = await p0;
  ok(r0.value === 20, 'async_pred_drop_replacement', r0);
}

async function test_replacement_takes_dropped_slot() {
  // The replacement pull is the newest pull chronologically but must occupy the
  // dropped position's ORDERING slot, not the tail. So a later position's value
  // (P2='C') known first cannot be delivered to C1 while the replacement of the
  // dropped P1 is still pending — if that replacement also dropped, 'C' would
  // belong to C1.
  const s = makeSource();
  const f = filter(s.it, (x) => x !== 'drop');
  const p0 = f.next(), p1 = f.next(), p2 = f.next(); // pulls 0,1,2
  await tick();
  s.value(2, 'C');    // P2's value known first
  await tick();
  s.value(1, 'drop'); // P1 drops -> replacement pull 3 inserted at slot 1
  await tick();
  s.value(0, 'A');    // P0 -> C0
  // C1 must NOT have grabbed 'C' while the replacement is still pending.
  let c1settled = false;
  p1.then(() => { c1settled = true; });
  await tick(); await tick();
  ok(c1settled === false, 'replacement_takes_dropped_slot: C1 waits for replacement');
  s.value(3, 'B');    // replacement kept
  const [r0, r1, r2] = await Promise.all([p0, p1, p2]);
  ok(r0.value === 'A' && r1.value === 'B' && r2.value === 'C',
    'replacement_takes_dropped_slot: delivered in call order', r0, r1, r2);
}

for (const t of [
  test_done_overrides_later_error,
  test_ceiling_lowers_on_drop_after_done,
  test_value_before_later_error,
  test_async_pred_drop_replacement,
  test_replacement_takes_dropped_slot,
]) {
  await t();
}
console.log(`extra cases done${process.exitCode ? ' (with failures)' : ''}`);

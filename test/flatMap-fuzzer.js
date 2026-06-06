// Invariant-based differential test for the concurrent `flatMap`.
//
// Usage:
//   node test/flatMap-fuzzer.js [N]                 exhaustive over schedules <= N events
//   node test/flatMap-fuzzer.js [N] --fuzz COUNT [--seed S]   random schedules
//   node test/flatMap-fuzzer.js [N] --replay '[..]'          replay one decision vector
//
// Unlike the map/filter fuzzers, this does NOT compare against a reimplemented
// oracle. flatMap's concurrent bookkeeping is exactly the thing under test, so a
// faithful model would be as likely to be wrong as the implementation. Instead we
// drive the REAL flatMap under a generated schedule, record everything the
// machinery does (every underlying pull, mapper call, inner-iterator pull, and
// every .return()), and check a set of invariants that any correct run must obey.
//
// Determinism / replay: a single `chooser` makes every nondeterministic decision
// in the run -- both top-level actions (consumer next()/return(), settle a pending
// promise) AND the "shape" each stub responds with (sync value/done/throw vs.
// pending). The chooser is consulted in a fixed order and microtask draining is
// deterministic, so the whole run is a pure function of the decision vector. A
// failing fuzz case prints its vector; `--replay` re-runs it exactly.
//
// Out of scope for now (per project direction): re-entrancy, throwing getters on
// iterator results, and sync-but-not-async iterables returned from the mapper.

import { parseArgs } from 'node:util';
import { flatMap } from '../flatMap.ts';

// --- microtask draining -----------------------------------------------------
//
// One settlement can trigger a synchronous cascade inside flatMap (an inner done
// redirecting to a fresh underlying pull, a mapper resolving and fanning out, a
// close chaining into another close). Rather than guess a fixed depth, drain in
// chunks until a whole chunk produces no new logged event: that is quiescence.
let FLUSH_CHUNK = 16;
const setFlushChunk = (n) => { FLUSH_CHUNK = n; };

// --- response-shape alphabets ----------------------------------------------

const PULL_SHAPES = ['syncValue', 'syncDone', 'syncThrow', 'pending'];
const MAPPER_SHAPES = ['syncIter', 'syncThrow', 'pending'];
const RETURN_SHAPES = ['sync', 'pending'];
const PULL_OUTCOMES = ['value', 'done', 'error'];
const MAPPER_OUTCOMES = ['iter', 'error'];

// --- value/error tags: pure functions of identity, so they are checkable -----
//
// An inner-iterator value is tagged `k:j` (inner iterator k, its pull j); this is
// exactly the value flatMap should pass through to the consumer, so a delivered
// `k:j` is self-describing. Underlying values (`U#`) are fed to the mapper and are
// never delivered. Errors are tagged by origin.
const innerValue = (k, j) => `${k}:${j}`;
const underlyingValue = (u) => `U${u}`;
const underlyingError = (u) => `Eu${u}`;
const mapperError = (m) => `Em${m}`;
const innerError = (k, j) => `Ei${k}.${j}`;

function fmtSettle(s) {
  if (s.type === 'value') return `{value:${s.value},done:false}`;
  if (s.type === 'done') return `{done:true}`;
  return `throw ${s.error}`;
}

// --- choosers (replayable + random) -----------------------------------------

class Chooser {
  constructor(decisions) {
    this.decisions = decisions;
    this.i = 0;
    this.frontierOptionCount = null;
  }
  choose(n) {
    if (this.i === this.decisions.length) this.frontierOptionCount = n;
    const idx = this.i < this.decisions.length ? this.decisions[this.i] : 0;
    this.i++;
    return idx;
  }
}

// mulberry32: a tiny seedable PRNG, so a fuzz run is reproducible from its seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RandomChooser {
  constructor(rng) {
    this.rng = rng;
    this.i = 0;
    this.decisions = [];
    this.frontierOptionCount = null;
  }
  choose(n) {
    const idx = Math.floor(this.rng() * n);
    this.decisions.push(idx);
    this.i++;
    return idx;
  }
}

// --- one run of the real flatMap under a schedule ---------------------------

async function runSchedule(maxEvents, chooser) {
  const maxPulls = 3 * maxEvents + 3; // bound the empty-inner / re-pull cascade

  // Structured record of everything observed. Invariants are checked against
  // this after the run; `events` is a flat human-readable trace for reports.
  const rec = {
    underlying: { pulls: [], returnCalls: 0, finished: null, finishedStep: null, returnStep: null }, // finished: 'done'|'error'
    inners: [],  // { id, pulls:[{idx,status,value?}], returnCalls, finished, createdWhileFinished }
    mappers: [], // { id, outcome:'pending'|'iter'|'error', innerId? }
    calls: [],   // { id, kind:'next'|'return', settle: null | {type,value?/error?} }
    events: [],
    violations: [],
  };

  // helperFinished: an over-approximation of "the flattened stream has ended",
  // used only to mark inner iterators that the mapper produces *after* the helper
  // is already done (the known mapper-pending leak). An inner done does NOT end
  // the stream, so it is deliberately excluded here.
  let helperFinished = false;

  let eventSeq = 0;
  const log = (line) => { rec.events.push(line); eventSeq++; };
  const violation = (msg) => { rec.violations.push(msg); log(`!! VIOLATION: ${msg}`); };

  // During finalization the stubs respond deterministically (clean wind-down)
  // and never consult the chooser: otherwise flatMap's wind-down pulls would
  // balloon the enumeration with finalize-only subtrees and could even fabricate
  // errors that were never part of the schedule under test.
  let finalizing = false;

  // stepNo identifies the current driving action (plus its flush-to-quiescence).
  // The "no use after finish" protocol checks are gated on it: flatMap issues a
  // burst of concurrent pulls synchronously, so if one settles done/error the
  // others in the SAME burst are still legitimate (the error is only observed a
  // microtask later). A genuine violation is touching an iterator in a LATER step
  // than the one in which it was seen to finish or be returned.
  let stepNo = 0;

  // pending obligations, kept in insertion order for deterministic enumeration
  const pendingPulls = [];   // { id, kind:'U'|'I', innerId?, idx, d }
  const pendingReturns = []; // { id, kind:'U'|'I', innerId?, d }
  let pendingMapper = null;  // { id, d } | null

  const flush = async () => {
    for (;;) {
      const before = eventSeq;
      for (let i = 0; i < FLUSH_CHUNK; i++) await Promise.resolve();
      if (eventSeq === before) return;
    }
  };

  // --- the underlying source ------------------------------------------------

  const source = {
    next() {
      const idx = rec.underlying.pulls.length;
      log(`U.next#${idx}`);
      if (rec.underlying.finishedStep != null && stepNo > rec.underlying.finishedStep) violation(`U.next#${idx} after underlying ${rec.underlying.finished}`);
      if (rec.underlying.returnStep != null && stepNo > rec.underlying.returnStep) violation(`U.next#${idx} after U.return()`);
      if (pendingPulls.some((p) => p.kind === 'U')) violation(`a second concurrent underlying pull at #${idx}`);
      const pull = { idx, status: 'pending' };
      rec.underlying.pulls.push(pull);
      const shape = (finalizing || idx >= maxPulls) ? 'syncDone' : PULL_SHAPES[chooser.choose(PULL_SHAPES.length)];
      if (shape === 'syncValue') { pull.status = 'value'; pull.value = underlyingValue(idx); return { value: pull.value, done: false }; }
      if (shape === 'syncDone') { pull.status = 'done'; rec.underlying.finished = 'done'; rec.underlying.finishedStep = stepNo; helperFinished = true; return { value: undefined, done: true }; }
      if (shape === 'syncThrow') { pull.status = 'error'; rec.underlying.finished = 'error'; rec.underlying.finishedStep = stepNo; helperFinished = true; throw new Error(underlyingError(idx)); }
      const d = Promise.withResolvers();
      pendingPulls.push({ id: `U#${idx}`, kind: 'U', idx, d });
      return d.promise;
    },
    return() {
      const n = rec.underlying.returnCalls;
      log(`U.return#${n}`);
      if (rec.underlying.finishedStep != null && stepNo > rec.underlying.finishedStep) violation(`U.return() after underlying ${rec.underlying.finished}`);
      if (n > 0) violation(`U.return() called more than once`);
      rec.underlying.returnCalls++;
      rec.underlying.returnStep = stepNo;
      const shape = finalizing ? 'sync' : RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
      if (shape === 'sync') return { value: undefined, done: true };
      const d = Promise.withResolvers();
      pendingReturns.push({ id: `Uret#${n}`, kind: 'U', d });
      return d.promise;
    },
    [Symbol.asyncIterator]() { return this; },
  };

  // --- inner iterators (one per successful mapper call) ----------------------

  const createInner = () => {
    const id = rec.inners.length;
    const inner = { id, pulls: [], returnCalls: 0, finished: null, finishedStep: null, returnStep: null, createdWhileFinished: helperFinished };
    rec.inners.push(inner);
    inner.iterator = {
      next() {
        const idx = inner.pulls.length;
        log(`I${id}.next#${idx}`);
        if (inner.finishedStep != null && stepNo > inner.finishedStep) violation(`I${id}.next#${idx} after inner ${inner.finished}`);
        if (inner.returnStep != null && stepNo > inner.returnStep) violation(`I${id}.next#${idx} after I${id}.return()`);
        const pull = { idx, status: 'pending' };
        inner.pulls.push(pull);
        const shape = (finalizing || idx >= maxPulls) ? 'syncDone' : PULL_SHAPES[chooser.choose(PULL_SHAPES.length)];
        if (shape === 'syncValue') { pull.status = 'value'; pull.value = innerValue(id, idx); return { value: pull.value, done: false }; }
        if (shape === 'syncDone') { pull.status = 'done'; inner.finished = 'done'; inner.finishedStep = stepNo; return { value: undefined, done: true }; }
        if (shape === 'syncThrow') { pull.status = 'error'; inner.finished = 'error'; inner.finishedStep = stepNo; helperFinished = true; throw new Error(innerError(id, idx)); }
        const d = Promise.withResolvers();
        pendingPulls.push({ id: `I${id}#${idx}`, kind: 'I', innerId: id, idx, d });
        return d.promise;
      },
      return() {
        const n = inner.returnCalls;
        log(`I${id}.return#${n}`);
        if (inner.finishedStep != null && stepNo > inner.finishedStep) violation(`I${id}.return() after inner ${inner.finished}`);
        if (n > 0) violation(`I${id}.return() called more than once`);
        inner.returnCalls++;
        inner.returnStep = stepNo;
        const shape = finalizing ? 'sync' : RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
        if (shape === 'sync') return { value: undefined, done: true };
        const d = Promise.withResolvers();
        pendingReturns.push({ id: `I${id}ret#${n}`, kind: 'I', innerId: id, d });
        return d.promise;
      },
      [Symbol.asyncIterator]() { return this; },
    };
    return inner;
  };

  // --- the mapper -----------------------------------------------------------

  const fn = (value) => {
    const id = rec.mappers.length;
    log(`fn#${id}(${value})`);
    if (pendingMapper) violation(`a second concurrent mapper call at #${id}`);
    const m = { id, outcome: 'pending', innerId: null };
    rec.mappers.push(m);
    const shape = finalizing ? 'syncIter' : MAPPER_SHAPES[chooser.choose(MAPPER_SHAPES.length)];
    if (shape === 'syncIter') { m.outcome = 'iter'; const inner = createInner(); m.innerId = inner.id; return inner.iterator; }
    if (shape === 'syncThrow') { m.outcome = 'error'; helperFinished = true; throw new Error(mapperError(id)); }
    const d = Promise.withResolvers();
    pendingMapper = { id, d };
    return d.promise;
  };

  const fm = flatMap(source, fn);

  // --- consumer-facing driving ----------------------------------------------

  const trackCall = (call, p) => {
    p.then(
      (r) => { call.settle = r.done ? { type: 'done' } : { type: 'value', value: r.value }; log(`${call.kind}#${call.id} -> ${fmtSettle(call.settle)}`); },
      (e) => { call.settle = { type: 'reject', error: e && e.message }; log(`${call.kind}#${call.id} -> throw ${e && e.message}`); },
    );
  };
  const doNext = () => {
    const call = { id: rec.calls.length, kind: 'next', settle: null };
    rec.calls.push(call);
    try { trackCall(call, Promise.resolve(fm.next())); }
    catch (e) { call.settle = { type: 'reject', error: e && e.message }; log(`next#${call.id} threw ${e && e.message}`); }
  };
  const doReturn = () => {
    const call = { id: rec.calls.length, kind: 'return', settle: null };
    rec.calls.push(call);
    helperFinished = true;
    try { trackCall(call, Promise.resolve(fm.return())); }
    catch (e) { call.settle = { type: 'reject', error: e && e.message }; log(`return#${call.id} threw ${e && e.message}`); }
  };

  // --- settling a chosen pending obligation ---------------------------------

  const settlePull = (entry, outcome) => {
    pendingPulls.splice(pendingPulls.indexOf(entry), 1);
    const pull = entry.kind === 'U' ? rec.underlying.pulls[entry.idx] : rec.inners[entry.innerId].pulls[entry.idx];
    if (outcome === 'value') {
      pull.status = 'value';
      pull.value = entry.kind === 'U' ? underlyingValue(entry.idx) : innerValue(entry.innerId, entry.idx);
      entry.d.resolve({ value: pull.value, done: false });
    } else if (outcome === 'done') {
      pull.status = 'done';
      if (entry.kind === 'U') { rec.underlying.finished = 'done'; rec.underlying.finishedStep = stepNo; helperFinished = true; }
      else { rec.inners[entry.innerId].finished = 'done'; rec.inners[entry.innerId].finishedStep = stepNo; }
      entry.d.resolve({ value: undefined, done: true });
    } else {
      pull.status = 'error';
      if (entry.kind === 'U') { rec.underlying.finished = 'error'; rec.underlying.finishedStep = stepNo; helperFinished = true; entry.d.reject(new Error(underlyingError(entry.idx))); }
      else { rec.inners[entry.innerId].finished = 'error'; rec.inners[entry.innerId].finishedStep = stepNo; helperFinished = true; entry.d.reject(new Error(innerError(entry.innerId, entry.idx))); }
    }
  };
  const settleMapper = (outcome) => {
    const m = rec.mappers[pendingMapper.id];
    const d = pendingMapper.d;
    pendingMapper = null;
    if (outcome === 'iter') { m.outcome = 'iter'; const inner = createInner(); m.innerId = inner.id; d.resolve(inner.iterator); }
    else { m.outcome = 'error'; helperFinished = true; d.reject(new Error(mapperError(m.id))); }
  };
  const settleReturn = (entry) => {
    pendingReturns.splice(pendingReturns.indexOf(entry), 1);
    entry.d.resolve({ value: undefined, done: true });
  };

  // --- legal action set at the current state --------------------------------

  const actions = [];
  const computeLegal = () => {
    if (actions.length >= maxEvents) return [{ t: 'stop' }];
    const legal = [{ t: 'next' }, { t: 'return' }];
    for (const p of pendingPulls) for (const o of PULL_OUTCOMES) legal.push({ t: 'settlePull', entry: p, o });
    if (pendingMapper) for (const o of MAPPER_OUTCOMES) legal.push({ t: 'settleMapper', o });
    for (const r of pendingReturns) legal.push({ t: 'settleReturn', entry: r });
    if (!pendingPulls.length && !pendingMapper && !pendingReturns.length) legal.push({ t: 'stop' });
    return legal;
  };
  const actionLabel = (a) => {
    switch (a.t) {
      case 'next': return 'next()';
      case 'return': return 'return()';
      case 'settlePull': return `settle ${a.entry.id}:${a.o}`;
      case 'settleMapper': return `settleMapper:${a.o}`;
      case 'settleReturn': return `settle ${a.entry.id}`;
      case 'stop': return 'stop';
    }
  };

  const apply = (a) => {
    if (a.t === 'next') doNext();
    else if (a.t === 'return') doReturn();
    else if (a.t === 'settlePull') settlePull(a.entry, a.o);
    else if (a.t === 'settleMapper') settleMapper(a.o);
    else if (a.t === 'settleReturn') settleReturn(a.entry);
  };

  // --- the main schedule ----------------------------------------------------

  for (;;) {
    const legal = computeLegal();
    const a = legal[chooser.choose(legal.length)];
    actions.push(a);
    if (a.t === 'stop') break;
    stepNo++;
    log(`--- ${actionLabel(a)}`);
    apply(a);
    await flush();
  }

  // Snapshot the natural end-of-schedule state BEFORE finalization perturbs it.
  // The cleanup/leak invariant reasons about what was open when the helper
  // terminated; finalization (which force-settles leftovers) would otherwise
  // rewrite "open" iterators into "finished" ones.
  rec.finishedNaturally = helperFinished;
  rec.underlying.naturalFinished = rec.underlying.finished;
  for (const inner of rec.inners) inner.naturalFinished = inner.finished;

  // --- finalization: drive to quiescence so cleanup/settle invariants apply --
  //
  // Settle whatever is still pending toward termination (pulls -> done, mapper ->
  // produce an inner iterator that then drains, returns -> done) until nothing is
  // pending. If this does not converge, flatMap has hung -- itself a failure.
  finalizing = true;
  let guard = 0;
  for (;;) {
    await flush();
    if (!pendingPulls.length && !pendingMapper && !pendingReturns.length) break;
    if (++guard > 2000) { violation('finalization did not reach quiescence (possible hang)'); break; }
    stepNo++;
    log(`--- finalize`);
    if (pendingPulls.length) settlePull(pendingPulls[0], 'done');
    else if (pendingMapper) settleMapper('iter');
    else settleReturn(pendingReturns[0]);
  }
  await flush();

  return {
    rec,
    decisions: chooser.decisions ?? null,
    numDecisions: chooser.i,
    frontierOptionCount: chooser.frontierOptionCount,
  };
}

// --- invariant checks (operate on the recording) ----------------------------

// Collect every error string the run actually produced, so a surfaced rejection
// can be validated against a real origin.
function realErrors(rec) {
  const s = new Set();
  rec.underlying.pulls.forEach((p) => { if (p.status === 'error') s.add(underlyingError(p.idx)); });
  rec.mappers.forEach((m) => { if (m.outcome === 'error') s.add(mapperError(m.id)); });
  rec.inners.forEach((inner) => inner.pulls.forEach((p) => { if (p.status === 'error') s.add(innerError(inner.id, p.idx)); }));
  return s;
}

// Set of all inner values actually produced (yielded by an inner pull).
function producedValues(rec) {
  const s = new Set();
  rec.inners.forEach((inner) => inner.pulls.forEach((p) => { if (p.status === 'value') s.add(p.value); }));
  return s;
}

function checkInvariants(rec) {
  const fails = [...rec.violations]; // protocol violations recorded live
  const add = (m) => fails.push(m);

  const nextCalls = rec.calls.filter((c) => c.kind === 'next');
  const retCalls = rec.calls.filter((c) => c.kind === 'return');

  // (I9) every consumer call settles after quiescence -- no hangs.
  for (const c of rec.calls) {
    if (c.settle === null) add(`call ${c.kind}#${c.id} never settled (hang)`);
  }

  // (I8) return() always resolves {done:true}; next() never resolves a non-result.
  for (const c of retCalls) {
    if (c.settle && c.settle.type !== 'done') add(`return#${c.id} settled as ${fmtSettle(c.settle)} (expected {done:true})`);
  }

  // (I4) every surfaced rejection carries an error that was actually produced.
  // Multiple rejections ARE allowed: concurrently-issued pulls each deliver their
  // own result -- value or error -- in order, so e.g. two inner pulls that both
  // reject surface two errors.
  const errs = realErrors(rec);
  for (const c of nextCalls) {
    if (c.settle && c.settle.type === 'reject' && !errs.has(c.settle.error)) {
      add(`next#${c.id} rejected with ${c.settle.error}, which was never produced`);
    }
  }

  // (I5) {done:true} is terminal in CALL order: once a call resolves done, no
  // later call (by call id) may resolve with a value or an error. A done may
  // settle earlier in TIME than an in-flight value (e.g. a return() whose done
  // lands before an already-requested value), but only when the done is later in
  // call order. Equivalently: dones form a suffix of the call sequence.
  let sawDone = false;
  for (const c of rec.calls) {
    if (!c.settle) continue;
    if (c.settle.type === 'done') sawDone = true;
    else if (sawDone) add(`call ${c.kind}#${c.id} delivered ${fmtSettle(c.settle)} after an earlier-in-call-order {done:true}`);
  }

  // (I1/I3) values delivered, in call order, are strictly increasing in
  // (innerIterCreationOrder, pullIndex) and were genuinely produced.
  const produced = producedValues(rec);
  let prevK = -1, prevJ = -1;
  for (const c of nextCalls) {
    if (!c.settle || c.settle.type !== 'value') continue;
    const v = c.settle.value;
    if (!produced.has(v)) { add(`next#${c.id} delivered ${v}, which no inner pull produced`); continue; }
    const m = /^(\d+):(\d+)$/.exec(v);
    if (!m) { add(`next#${c.id} delivered a non-inner value ${v}`); continue; }
    const k = Number(m[1]), j = Number(m[2]);
    if (k < prevK || (k === prevK && j <= prevJ)) {
      add(`out-of-order/duplicate delivery: next#${c.id} got ${v} after (${prevK}:${prevJ})`);
    }
    prevK = k; prevJ = j;
  }

  // (I7) cleanup / "closed iff": an iterator that flatMap was actively consuming
  // (it was pulled) must, once the helper has terminated, either have finished on
  // its own (a pull reported done/error) or have been closed via .return() -- it
  // must not be left open and abandoned (a leak). We only check this when the
  // helper terminated naturally (return(), or a terminal done/error): a consumer
  // that merely paused mid-stream leaves iterators legitimately suspended.
  // (Whether flatMap WRONGLY closes a self-finished iterator is caught live as a
  // return-after-finish violation, so we only check the leak direction here.)
  if (rec.finishedNaturally) {
    // The underlying only needs closing if it was ever pulled (return() before
    // the first pull correctly touches nothing).
    if (rec.underlying.pulls.length > 0 && !rec.underlying.naturalFinished && rec.underlying.returnCalls === 0) {
      add(`underlying was left open at termination (pulled, not finished, not .return()'d): leak`);
    }
    for (const inner of rec.inners) {
      if (inner.pulls.length === 0) {
        // A live inner is always pulled immediately on creation, so a zero-pull
        // inner can only be one the mapper produced AFTER the helper finished.
        // That is the known mapper-pending leak (see the xfail in
        // test/flatMap.js); exempt it until that bug is fixed.
        if (!inner.createdWhileFinished) add(`inner I${inner.id} was created but never pulled`);
        continue;
      }
      if (!inner.naturalFinished && inner.returnCalls === 0) {
        add(`inner I${inner.id} was left open at termination (pulled, not finished, not .return()'d): leak`);
      }
    }
  }

  // (I-strong, gated) For a well-behaved, error-free, return-free schedule the
  // delivered next() results, in call order, must equal the flattened
  // concatenation of all inner values, followed by dones.
  const strong = strongCheck(rec, nextCalls);
  if (strong) add(strong);

  return fails;
}

// Returns a failure string, or null if the gate doesn't apply or it passes.
function strongCheck(rec, nextCalls) {
  if (rec.calls.some((c) => c.kind === 'return')) return null;
  if (rec.underlying.finished !== 'done') return null;
  if (rec.underlying.pulls.some((p) => p.status === 'error')) return null;
  if (rec.mappers.some((m) => m.outcome === 'error')) return null;
  if (rec.inners.some((inner) => inner.pulls.some((p) => p.status === 'error' || p.status === 'pending'))) return null;
  if (rec.underlying.pulls.some((p) => p.status === 'pending')) return null;

  // underlying well-behaved: values..., exactly one done, done is last.
  const up = rec.underlying.pulls;
  for (let i = 0; i < up.length; i++) {
    if (i < up.length - 1 && up[i].status !== 'value') return null;
    if (i === up.length - 1 && up[i].status !== 'done') return null;
  }

  // each inner well-behaved: values at 0..d-1 then optionally a single done at the
  // last index; no value after a done.
  for (const inner of rec.inners) {
    for (let j = 0; j < inner.pulls.length; j++) {
      const st = inner.pulls[j].status;
      if (st === 'done') { if (j !== inner.pulls.length - 1) return null; }
      else if (st !== 'value') return null;
    }
  }

  // expected flattened stream
  const concat = [];
  for (const inner of rec.inners) {
    for (const p of inner.pulls) {
      if (p.status === 'value') concat.push(p.value);
      else break; // done
    }
  }

  for (let i = 0; i < nextCalls.length; i++) {
    const c = nextCalls[i];
    const expected = i < concat.length ? { type: 'value', value: concat[i] } : { type: 'done' };
    if (!c.settle) return `strong: next#${c.id} never settled`;
    if (fmtSettle(c.settle) !== fmtSettle(expected)) {
      return `strong: next#${c.id} = ${fmtSettle(c.settle)}, expected ${fmtSettle(expected)} (concat=[${concat.join(',')}])`;
    }
  }
  return null;
}

// --- driving the checks -----------------------------------------------------

function report(label, r, fails) {
  console.log('FAILURE');
  console.log(`  case: ${label}`);
  if (r.decisions) console.log(`  replay with: node ${process.argv[1]} ${process.argv[2] ?? ''} --replay '${JSON.stringify(r.decisions)}'`);
  console.log('  invariant failures:');
  for (const f of fails) console.log(`    - ${f}`);
  console.log('  trace:');
  for (const line of r.rec.events) console.log(`    ${line}`);
  console.log('');
}

async function checkOne(maxEvents, chooser, label) {
  const r = await runSchedule(maxEvents, chooser);
  const fails = checkInvariants(r.rec);
  if (fails.length) { report(label, r, fails); return false; }
  return true;
}

async function runExhaustive(maxEvents) {
  const worklist = [[]];
  let count = 0;
  while (worklist.length) {
    const V = worklist.pop();
    const r = await runSchedule(maxEvents, new Chooser(V));
    if (r.numDecisions === V.length) {
      count++;
      const fails = checkInvariants(r.rec);
      if (fails.length) { report(`exhaustive #${count}`, r, fails); process.exitCode = 1; return; }
    } else {
      for (let a = 0; a < r.frontierOptionCount; a++) worklist.push([...V, a]);
    }
  }
  console.log(`N = ${maxEvents}; schedules explored: ${count}`);
  console.log('all schedules passed');
}

async function runFuzz(maxEvents, cases, seedArg) {
  const baseSeed = seedArg !== undefined ? (Number(seedArg) >>> 0) : (Math.floor(Math.random() * 2 ** 32) >>> 0);
  console.log(`fuzzing N = ${maxEvents}; cases = ${cases}; seed = ${baseSeed}`);
  for (let i = 0; i < cases; i++) {
    const rng = mulberry32((baseSeed + Math.imul(i, 0x9e3779b9)) >>> 0);
    if (!(await checkOne(maxEvents, new RandomChooser(rng), `fuzz #${i} (seed ${baseSeed})`))) {
      process.exitCode = 1;
      return;
    }
  }
  console.log(`N = ${maxEvents}; fuzz cases run: ${cases} (seed ${baseSeed})`);
  console.log('all fuzz cases passed');
}

async function runReplay(maxEvents, decisions) {
  console.log('replaying decisions: ' + JSON.stringify(decisions));
  const r = await runSchedule(maxEvents, new Chooser(decisions));
  const fails = checkInvariants(r.rec);
  if (fails.length) { report('replay', r, fails); process.exitCode = 1; }
  else { for (const line of r.rec.events) console.log('  ' + line); console.log('replay passed (no invariant violations)'); }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fuzz: { type: 'string' },
      seed: { type: 'string' },
      replay: { type: 'string' },
    },
  });
  const maxEvents = Number(positionals[0] ?? 4);
  setFlushChunk(Math.max(16, 3 * maxEvents));
  if (values.replay !== undefined) return runReplay(maxEvents, JSON.parse(values.replay));
  if (values.fuzz !== undefined) return runFuzz(maxEvents, Number(values.fuzz), values.seed);
  return runExhaustive(maxEvents);
}

main();

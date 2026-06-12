// TODO: actual fuzzing support, like the other fuzzers

// Bounded-exhaustive differential test for the concurrent `map`.
//
// Idea: enumerate every distinct *schedule* of up to N consumer calls
// (`.next()` / `.return()`) interleaved with the ways the underlying iterator
// and the mapper can respond, run the real `map` under each schedule, and check
// it against a synchronous reference "oracle" that encodes the desired
// concurrent semantics. Where the underlying iterator is well-behaved and
// error-free we additionally assert the headline ordering property against an
// independent sequential computation (which cross-checks the oracle itself).
//
// An "event" is one atomic step. A schedule is a total order of them. Between
// events we flush microtasks to quiescence, so the timeline is discrete and
// each schedule is deterministic. Whenever an event needs a value it is a pure
// function of the producing obligation's id, so values line up across the
// oracle and the real run.
//
// Comparison is per-step and order-insensitive *within* a step (a sorted
// multiset of observable events), because intra-flush microtask ordering is an
// implementation detail; what we assert is which step things happen in.
//
// Usage: `node test/map-bounded-exhaustive.js [N]`   (default N = 2)

import { map } from '../map.js';

// Flush to microtask quiescence between driving actions. A single driving
// action's consequences propagate through a promise chain of bounded depth (the
// map machinery's chain is short and does not grow with N), so a small fixed
// number of microtask turns suffices. If this were ever too small the per-step
// trace comparison would fail (an event would land in a later step), so the
// suite is self-checking on this constant. Not time-based: no delay, and every
// settlement is still manual.
// 16 leaves comfortable margin over the empirically-observed max chain depth of
// ~10 (the map machinery's longest reaction: pull -> mapper -> error -> close ->
// finally -> catch -> consumer).
const FLUSH_ROUNDS = 16;
const flush = async () => { for (let i = 0; i < FLUSH_ROUNDS; i++) await Promise.resolve(); };

// --- response-shape alphabets (chosen when an obligation is created) --------

const PULL_SHAPES = ['syncValue', 'syncDone', 'syncThrow', 'pending'];
const MAPPER_SHAPES = ['syncValue', 'syncThrow', 'pending'];
const RETURN_SHAPES = ['sync', 'pending'];
const PULL_OUTCOMES = ['value', 'done', 'reject']; // for a pending pull
const MAPPER_OUTCOMES = ['value', 'reject']; // for a pending mapper

// --- values/errors are pure functions of obligation identity ---------------

const pullValue = (id) => `P${id}`;
const mapped = (arg) => `m(${arg})`;
const pullError = (id) => `Epull${id}`;
const mapperError = (arg) => `Emap(${arg})`;

// canonical text for a settled consumer result, shared by oracle and real run
function fmtResult({ value, done }) {
  if (done) return value === undefined ? `{done:true}` : `{value:${value},done:true}`;
  return `{value:${value},done:false}`;
}
const evNext = (callId, rhs) => `next#${callId} -> ${rhs}`;
const evNextThrow = (callId, msg) => `next#${callId} -> throw ${msg}`;
const evReturn = (callId, rhs) => `return#${callId} -> ${rhs}`;
const evUNext = (id) => `U.next#${id}`;
const evUReturn = (id) => `U.return#${id}`;
const evFn = (arg) => `fn(${arg})`;

function actionLabel(a) {
  switch (a.t) {
    case 'next': return 'next()';
    case 'return': return 'return()';
    case 'settlePull': return `settlePull#${a.id}:${a.o}`;
    case 'settleMapper': return `settleMapper#${a.id}:${a.o}`;
    case 'settleReturn': return `settleReturn#${a.id}`;
    case 'stop': return 'stop';
  }
}

// --- chooser: drives one run from a decision vector -------------------------

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

// --- the oracle: a synchronous model of the desired concurrent semantics ----
//
// Runs one schedule (driven by `chooser`), producing the structured schedule,
// the per-step event multiset trace, and each consumer call's settled result.

function runModel(N, chooser) {
  let done = false;
  let budget = N;
  let callCount = 0;
  let nextPullId = 0, nextMapperId = 0, nextReturnId = 0;

  const pendingPulls = [];   // { id, callId }
  const pendingMappers = []; // { id, callId, arg }
  const pendingReturns = []; // { id, kind: 'explicit'|'closeReject', callId, err? }

  const schedule = { pullShapes: [], mapperShapes: [], returnShapes: [], actions: [] };
  const modelTrace = [];
  const callResults = []; // [callId] -> { type:'next'|'return', rhs }

  let ev; // current step's event list

  const settleNext = (callId, result) => {
    callResults[callId] = { type: 'next', rhs: fmtResult(result) };
    ev.push(evNext(callId, fmtResult(result)));
  };
  const rejectNext = (callId, msg) => {
    callResults[callId] = { type: 'next', rhs: `throw ${msg}` };
    ev.push(evNextThrow(callId, msg));
  };
  const settleReturn = (callId) => {
    callResults[callId] = { type: 'return', rhs: `{done:true}` };
    ev.push(evReturn(callId, `{done:true}`));
  };

  // predicate error: close the underlying iterator then reject the call — but
  // only if the machinery is still live. If we're already done (closed,
  // returned, or the underlying errored or finished), don't touch it.
  const predicateError = (callId, msg) => {
    if (done) {
      rejectNext(callId, msg);
      return;
    }
    done = true;
    const id = nextReturnId++;
    const shape = RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
    schedule.returnShapes[id] = shape;
    ev.push(evUReturn(id));
    if (shape === 'sync') rejectNext(callId, msg);
    else pendingReturns.push({ id, kind: 'closeReject', callId, err: msg });
  };

  const invokeMapper = (callId, arg) => {
    const id = nextMapperId++;
    const shape = MAPPER_SHAPES[chooser.choose(MAPPER_SHAPES.length)];
    schedule.mapperShapes[id] = shape;
    ev.push(evFn(arg));
    if (shape === 'syncValue') settleNext(callId, { value: mapped(arg), done: false });
    else if (shape === 'syncThrow') predicateError(callId, mapperError(arg));
    else pendingMappers.push({ id, callId, arg });
  };

  // a pull (from consumer call `callId`) yields `outcome`
  const resolvePull = (callId, pullId, outcome) => {
    if (outcome === 'value') invokeMapper(callId, pullValue(pullId));
    else if (outcome === 'done') { done = true; settleNext(callId, { value: undefined, done: true }); }
    else { done = true; rejectNext(callId, pullError(pullId)); } // underlying error: no close
  };

  const computeLegal = () => {
    const legal = [];
    if (budget > 0) { legal.push({ t: 'next' }); legal.push({ t: 'return' }); }
    for (const p of pendingPulls) for (const o of PULL_OUTCOMES) legal.push({ t: 'settlePull', id: p.id, o });
    for (const m of pendingMappers) for (const o of MAPPER_OUTCOMES) legal.push({ t: 'settleMapper', id: m.id, o });
    for (const r of pendingReturns) legal.push({ t: 'settleReturn', id: r.id });
    if (!pendingPulls.length && !pendingMappers.length && !pendingReturns.length) legal.push({ t: 'stop' });
    return legal;
  };

  for (;;) {
    const legal = computeLegal();
    const act = legal[chooser.choose(legal.length)];
    schedule.actions.push(act);
    if (act.t === 'stop') break;

    ev = [];
    if (act.t === 'next') {
      const callId = callCount++; budget--;
      if (done) {
        settleNext(callId, { value: undefined, done: true });
      } else {
        const pullId = nextPullId++;
        const shape = PULL_SHAPES[chooser.choose(PULL_SHAPES.length)];
        schedule.pullShapes[pullId] = shape;
        ev.push(evUNext(pullId));
        if (shape === 'syncValue') resolvePull(callId, pullId, 'value');
        else if (shape === 'syncDone') resolvePull(callId, pullId, 'done');
        else if (shape === 'syncThrow') resolvePull(callId, pullId, 'reject');
        else pendingPulls.push({ id: pullId, callId });
      }
    } else if (act.t === 'return') {
      const callId = callCount++; budget--;
      if (done) {
        settleReturn(callId);
      } else {
        done = true;
        const id = nextReturnId++;
        const shape = RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
        schedule.returnShapes[id] = shape;
        ev.push(evUReturn(id));
        if (shape === 'sync') settleReturn(callId);
        else pendingReturns.push({ id, kind: 'explicit', callId });
      }
    } else if (act.t === 'settlePull') {
      const idx = pendingPulls.findIndex((p) => p.id === act.id);
      const p = pendingPulls[idx];
      pendingPulls.splice(idx, 1);
      resolvePull(p.callId, p.id, act.o);
    } else if (act.t === 'settleMapper') {
      const idx = pendingMappers.findIndex((m) => m.id === act.id);
      const m = pendingMappers[idx];
      pendingMappers.splice(idx, 1);
      if (act.o === 'value') settleNext(m.callId, { value: mapped(m.arg), done: false });
      else predicateError(m.callId, mapperError(m.arg));
    } else if (act.t === 'settleReturn') {
      const idx = pendingReturns.findIndex((r) => r.id === act.id);
      const r = pendingReturns[idx];
      pendingReturns.splice(idx, 1);
      if (r.kind === 'explicit') settleReturn(r.callId);
      else rejectNext(r.callId, r.err);
    }
    modelTrace.push(ev.slice().sort());
  }

  return {
    schedule,
    modelTrace,
    callResults,
    numDecisions: chooser.i,
    frontierOptionCount: chooser.frontierOptionCount,
  };
}

// --- enumerate every complete schedule via decision-vector DFS --------------

function* enumerate(N) {
  const worklist = [[]]; // a LIFO stack -> depth-first, so it stays small
  while (worklist.length) {
    const V = worklist.pop();
    const r = runModel(N, new Chooser(V));
    if (r.numDecisions === V.length) {
      yield r; // V pinned every decision -> one complete schedule
    } else {
      for (let a = 0; a < r.frontierOptionCount; a++) worklist.push([...V, a]);
    }
  }
}

// --- run the real `map` under a structured schedule -------------------------

function runReal(schedule) {
  let cur = []; // current step's events
  const log = (s) => cur.push(s);

  const pendingPulls = new Map();   // id -> resolvers
  const pendingMappers = new Map(); // id -> { d, arg }
  const pendingReturns = new Map(); // id -> resolvers
  let nextPullId = 0, nextMapperId = 0, nextReturnId = 0;

  // Invariant: once the machinery has observed an error from the underlying
  // iterator (a rejected / synchronously-throwing .next()), it must never call
  // the underlying .return(). Tracked independently of the oracle.
  let underlyingErrored = false;
  let invariantViolation = null;

  const source = {
    next() {
      const id = nextPullId++;
      log(evUNext(id));
      const shape = schedule.pullShapes[id];
      if (shape === undefined) { log(`!! unexpected ${evUNext(id)}`); return Promise.resolve({ value: undefined, done: true }); }
      if (shape === 'syncValue') return { value: pullValue(id), done: false };
      if (shape === 'syncDone') return { value: undefined, done: true };
      if (shape === 'syncThrow') { underlyingErrored = true; throw new Error(pullError(id)); }
      const d = Promise.withResolvers();
      pendingPulls.set(id, d);
      return d.promise;
    },
    return() {
      const id = nextReturnId++;
      log(evUReturn(id));
      if (underlyingErrored && !invariantViolation) {
        invariantViolation = `called underlying .return()#${id} after observing an underlying error`;
      }
      const shape = schedule.returnShapes[id];
      if (shape === undefined) { log(`!! unexpected ${evUReturn(id)}`); return Promise.resolve({ value: undefined, done: true }); }
      if (shape === 'sync') return { value: undefined, done: true };
      const d = Promise.withResolvers();
      pendingReturns.set(id, d);
      return d.promise;
    },
    [Symbol.asyncIterator]() { return this; },
  };

  const fn = (arg) => {
    const id = nextMapperId++;
    log(evFn(arg));
    const shape = schedule.mapperShapes[id];
    if (shape === undefined) { log(`!! unexpected ${evFn(arg)}#${id}`); return undefined; }
    if (shape === 'syncValue') return mapped(arg);
    if (shape === 'syncThrow') throw new Error(mapperError(arg));
    const d = Promise.withResolvers();
    pendingMappers.set(id, { d, arg });
    return d.promise;
  };

  const mappedIt = map(source, fn);
  const realTrace = [];
  let callCount = 0;
  const callSettled = []; // callId -> true once its promise settles

  const trackNext = (callId, p) => p.then(
    (r) => { callSettled[callId] = true; log(evNext(callId, fmtResult(r))); },
    (e) => { callSettled[callId] = true; log(evNextThrow(callId, e && e.message)); },
  );
  const trackReturn = (callId, p) => p.then(
    (r) => { callSettled[callId] = true; log(evReturn(callId, fmtResult(r))); },
    (e) => { callSettled[callId] = true; log(`return#${callId} -> throw ${e && e.message}`); },
  );

  // Oracle-independent settlement invariants, checked at each action's quiescence:
  // - liveness: with no underlying/mapper/return promise pending and microtasks
  //   drained, an unsettled consumer call can never settle (nothing can wake the
  //   machinery), even if a later consumer call would mask the hang.
  // - close-gating: while an underlying .return() the machinery issued is still
  //   pending, some consumer promise must be unsettled (return() results and
  //   mapper-error rejections await their close).
  const checkSettlementInvariants = () => {
    if (invariantViolation) return; // report the first violation only
    let unsettledId = -1;
    for (let i = 0; i < callCount; i++) if (!callSettled[i]) { unsettledId = i; break; }
    if (!pendingPulls.size && !pendingMappers.size && !pendingReturns.size && unsettledId !== -1) {
      invariantViolation = `liveness: call #${unsettledId} is unsettled at quiescence with nothing pending`;
    } else if (pendingReturns.size && unsettledId === -1) {
      invariantViolation = `close-gating: underlying .return() #${[...pendingReturns.keys()].join(', #')} pending but every consumer call has settled`;
    }
  };

  return (async () => {
    for (const act of schedule.actions) {
      if (act.t === 'stop') break;
      cur = [];
      if (act.t === 'next') {
        const callId = callCount++;
        try { trackNext(callId, Promise.resolve(mappedIt.next())); }
        catch (e) { callSettled[callId] = true; log(evNextThrow(callId, e && e.message)); }
      } else if (act.t === 'return') {
        const callId = callCount++;
        try { trackReturn(callId, Promise.resolve(mappedIt.return())); }
        catch (e) { callSettled[callId] = true; log(`return#${callId} -> throw ${e && e.message}`); }
      } else if (act.t === 'settlePull') {
        const d = pendingPulls.get(act.id);
        if (!d) log(`!! settlePull#${act.id} not pending`);
        else {
          pendingPulls.delete(act.id);
          if (act.o === 'value') d.resolve({ value: pullValue(act.id), done: false });
          else if (act.o === 'done') d.resolve({ value: undefined, done: true });
          else { underlyingErrored = true; d.reject(new Error(pullError(act.id))); }
        }
      } else if (act.t === 'settleMapper') {
        const m = pendingMappers.get(act.id);
        if (!m) log(`!! settleMapper#${act.id} not pending`);
        else {
          pendingMappers.delete(act.id);
          if (act.o === 'value') m.d.resolve(mapped(m.arg));
          else m.d.reject(new Error(mapperError(m.arg)));
        }
      } else if (act.t === 'settleReturn') {
        const d = pendingReturns.get(act.id);
        if (!d) log(`!! settleReturn#${act.id} not pending`);
        else { pendingReturns.delete(act.id); d.resolve({ value: undefined, done: true }); }
      }
      await flush();
      checkSettlementInvariants();
      realTrace.push(cur.slice().sort());
    }
    return { realTrace, invariantViolation };
  })();
}

// --- independent property check (gated on the underlying being justifiable) -

// Determine each pull's eventual outcome kind from the schedule.
function pullOutcomeKinds(schedule) {
  const kinds = [];
  for (let id = 0; id < schedule.pullShapes.length; id++) {
    const shape = schedule.pullShapes[id];
    if (shape === 'syncValue') kinds[id] = 'value';
    else if (shape === 'syncDone') kinds[id] = 'done';
    else if (shape === 'syncThrow') kinds[id] = 'error';
    else {
      const a = schedule.actions.find((x) => x.t === 'settlePull' && x.id === id);
      kinds[id] = a.o === 'value' ? 'value' : a.o === 'done' ? 'done' : 'error';
    }
  }
  return kinds;
}

function isErrorFree(schedule) {
  if (schedule.mapperShapes.includes('syncThrow')) return false;
  if (pullOutcomeKinds(schedule).includes('error')) return false;
  if (schedule.actions.some((a) => a.t === 'settleMapper' && a.o === 'reject')) return false;
  return true;
}

// well-behaved underlying: error-free, and in pull order all values precede
// any done (a sequential consumer would have stopped at the first done).
function isWellBehaved(schedule) {
  if (!isErrorFree(schedule)) return false;
  const kinds = pullOutcomeKinds(schedule);
  let sawDone = false;
  for (const k of kinds) {
    if (k === 'done') sawDone = true;
    else if (sawDone && k === 'value') return false;
  }
  return true;
}

// The headline ordering property: reading consumer results in call order gives
// the same sequence as a sequential map over the same (well-behaved) underlying.
// Computed independently of the oracle; compared against the oracle's results.
function checkSequentialProperty(schedule, callResults) {
  if (!isWellBehaved(schedule)) return null; // not justified by this underlying
  const kinds = pullOutcomeKinds(schedule);
  let done = false;
  let pi = 0;
  let callId = 0;
  for (const act of schedule.actions) {
    if (act.t !== 'next' && act.t !== 'return') continue;
    let expectedRhs;
    if (act.t === 'next') {
      if (done) expectedRhs = `{done:true}`;
      else if (kinds[pi] === 'value') { expectedRhs = `{value:${mapped(pullValue(pi))},done:false}`; pi++; }
      else { done = true; expectedRhs = `{done:true}`; pi++; }
    } else {
      done = true;
      expectedRhs = `{done:true}`;
    }
    const actual = callResults[callId];
    if (!actual || actual.rhs !== expectedRhs) {
      return { callId, expectedRhs, actualRhs: actual ? actual.rhs : '(none)' };
    }
    callId++;
  }
  return null;
}

// --- trace comparison -------------------------------------------------------

function compareTraces(model, real) {
  if (model.length !== real.length) {
    return { kind: 'length', model: model.length, real: real.length };
  }
  for (let i = 0; i < model.length; i++) {
    const a = model[i].join(' | ');
    const b = real[i].join(' | ');
    if (a !== b) return { kind: 'step', step: i, model: model[i], real: real[i] };
  }
  return null;
}

// --- main -------------------------------------------------------------------

async function main() {
  const N = Number(process.argv[2] ?? 2);

  let scheduleCount = 0;
  let traceFailures = 0;
  let propertyFailures = 0;
  let invariantFailures = 0;
  const MAX_REPORT = 10;

  for (const s of enumerate(N)) {
    scheduleCount++;
    const { realTrace, invariantViolation } = await runReal(s.schedule);
    const diff = compareTraces(s.modelTrace, realTrace);
    if (diff) {
      traceFailures++;
      if (traceFailures <= MAX_REPORT) reportTraceFailure(s, realTrace, diff);
    }
    if (invariantViolation) {
      invariantFailures++;
      if (invariantFailures <= MAX_REPORT) reportInvariantFailure(s, invariantViolation);
    }
    const prop = checkSequentialProperty(s.schedule, s.callResults);
    if (prop) {
      propertyFailures++;
      if (propertyFailures <= MAX_REPORT) reportPropertyFailure(s, prop);
    }
  }

  console.log('');
  console.log(`N = ${N}`);
  console.log(`schedules explored: ${scheduleCount}`);
  console.log(`trace mismatches (real vs oracle): ${traceFailures}`);
  console.log(`invariant violations: ${invariantFailures}`);
  console.log(`property violations (oracle vs sequential spec): ${propertyFailures}`);
  if (traceFailures === 0 && propertyFailures === 0 && invariantFailures === 0) {
    console.log('all schedules passed');
  } else {
    process.exitCode = 1;
  }
}

function describeSchedule(s) {
  return s.schedule.actions.map(actionLabel).join('  ');
}

function reportTraceFailure(s, realTrace, diff) {
  console.log('TRACE MISMATCH');
  console.log('  schedule: ' + describeSchedule(s));
  console.log('  pullShapes:   ' + JSON.stringify(s.schedule.pullShapes));
  console.log('  mapperShapes: ' + JSON.stringify(s.schedule.mapperShapes));
  console.log('  returnShapes: ' + JSON.stringify(s.schedule.returnShapes));
  if (diff.kind === 'length') {
    console.log(`  step count differs: oracle=${diff.model} real=${diff.real}`);
  } else {
    console.log(`  step ${diff.step} (${actionLabel(s.schedule.actions[diff.step])}):`);
    console.log('    oracle: ' + JSON.stringify(diff.model));
    console.log('    real:   ' + JSON.stringify(diff.real));
  }
  console.log('');
}

function reportInvariantFailure(s, violation) {
  console.log('INVARIANT VIOLATION');
  console.log('  schedule: ' + describeSchedule(s));
  console.log('  ' + violation);
  console.log('');
}

function reportPropertyFailure(s, prop) {
  console.log('PROPERTY VIOLATION (oracle disagrees with sequential spec)');
  console.log('  schedule: ' + describeSchedule(s));
  console.log(`  call #${prop.callId}: expected ${prop.expectedRhs}, oracle gave ${prop.actualRhs}`);
  console.log('');
}

main();

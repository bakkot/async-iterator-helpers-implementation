// Bounded-exhaustive differential test for the concurrent `filter`.
//
// Usage: `node test/filter-bounded-exhaustive.js [N] [--fuzz count] [--seed s]`
//                                                       (default N = 5)
//
// N bounds the total number of harness events in a schedule -- consumer
// next()/return() calls plus underlying pull/predicate/return settlements.
// Once a schedule reaches N events it is forced to stop (leaving any in-flight
// operations unsettled), so the schedule space scales gently with N and N can
// be raised incrementally. Underlying pulls are separately capped to bound the
// sync-false replacement chains a single event can trigger.
//
// With `--fuzz count` the test runs `count` randomly-generated schedules at the
// given N instead of enumerating exhaustively, which is how large N (where the
// exhaustive space is infeasible) gets covered. See RandomChooser below for the
// reachability guarantee. A failing fuzz case prints a `--replay` vector that
// re-runs that exact schedule deterministically.

import { parseArgs } from 'node:util';
import { filter } from '../filter.js';

// Adaptive microtask drain. A single action can trigger a synchronous cascade
// of sync-false replacement pulls (each ~2 hops) before the final settlement,
// and the flush must reach quiescence or it truncates the real trace. Rather
// than guess a fixed worst-case count, drain in chunks until a whole chunk adds
// nothing new to the log. The chunk only has to exceed the largest gap between
// consecutively-logged events (a couple of promise-adoption hops), which
// 2*maxEvents comfortably clears; the common shallow schedules then settle in
// one or two chunks instead of paying the deep-cascade worst case every time.
let FLUSH_CHUNK = 16;
const setFlushChunk = (n) => { FLUSH_CHUNK = n; };
const flush = async (logLength) => {
  for (;;) {
    const before = logLength();
    for (let i = 0; i < FLUSH_CHUNK; i++) await Promise.resolve();
    if (logLength() === before) return;
  }
};

// The driver settles exactly one underlying promise per action and flushes to
// quiescence before the next, so cascades never interleave. Within one cascade
// `filter` performs all its synchronous underlying calls (source.next/return,
// predicate) at or before the hop that resolves any consumer, so the observable
// order is always [sync calls in call order] ++ [settlements in resolution
// order]. The oracle reproduces that by partitioning, rather than predicting
// exact microtask hops. checkPartialOrder() guards that premise (see below);
// set NO_PARTIAL_ORDER=1 to skip it for speed once it's established.
const CHECK_PARTIAL_ORDER = process.env.NO_PARTIAL_ORDER !== '1';

const PULL_SHAPES = ['syncValue', 'syncDone', 'syncThrow', 'pending'];
const PRED_SHAPES = ['syncTrue', 'syncFalse', 'syncThrow', 'pending'];
const RETURN_SHAPES = ['sync', 'pending'];
const PULL_OUTCOMES = ['value', 'done', 'reject'];
const PRED_OUTCOMES = ['true', 'false', 'reject'];

const pullValue = (id) => `P${id}`;
const pullError = (id) => `Epull${id}`;
const predError = (arg) => `Epred(${arg})`;

function fmtResult({ value, done }) {
  if (done) return value === undefined ? `{done:true}` : `{value:${value},done:true}`;
  return `{value:${value},done:false}`;
}
const evNext = (callId, rhs) => `next#${callId} -> ${rhs}`;
const evNextThrow = (callId, msg) => `next#${callId} -> throw ${msg}`;
const evReturn = (callId, rhs) => `return#${callId} -> ${rhs}`;
const evReturnThrow = (callId, msg) => `return#${callId} -> throw ${msg}`;
const evUNext = (id) => `U.next#${id}`;
const evUReturn = (id) => `U.return#${id}`;
const evPred = (arg) => `pred(${arg})`;

function actionLabel(a) {
  switch (a.t) {
    case 'next': return 'next()';
    case 'return': return 'return()';
    case 'settlePull': return `settlePull#${a.id}:${a.o}`;
    case 'settlePred': return `settlePred#${a.id}:${a.o}`;
    case 'settleReturn': return `settleReturn#${a.id}`;
    case 'stop': return 'stop';
  }
}

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

// The fuzzing counterpart to Chooser: instead of replaying a fixed decision
// vector it picks a uniformly random option at each branch point. Because every
// option at every choose(n) has positive probability, a fuzz run can reach
// *exactly* the schedules enumerate() can -- there is no schedule the exhaustive
// search produces that the fuzzer cannot. It does not hit them with equal
// probability, though: per-decision uniform choice weights a schedule by the
// product of 1/n over its branches, so short schedules (and the empty one, when
// `stop` is among the first legal options) are oversampled relative to deep
// ones. Equalizing would require weighting each choice by the leaf-count of its
// subtree, which means knowing the whole tree -- the thing fuzzing exists to
// avoid. It records its choices so a failing case can be replayed via Chooser.
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

function runModel(maxEvents, chooser) {
  const maxPulls = Math.max(1, 2 * maxEvents);
  let done = false;
  let callCount = 0;
  let nextPullId = 0, nextPredId = 0, nextReturnId = 0;
  let terminalIndex = Infinity;

  const nodes = [];     // retained pull slots, in pull order
  const consumers = []; // pending next() call ids, in call order
  let valueLimit = 0;   // pending/value/error slots before the terminal wall
  let deferredError = null; // a head predicate error committed to a call but
                            // awaiting its source close: { callId, error }

  const pendingPulls = [];   // { id, node }
  const pendingPreds = [];   // { id, node, arg }
  const pendingReturns = []; // pending it.return()s: explicit return() calls
                             // ({id, callId}) and predicate-error closes
                             // ({id, heldNode}), each settled by a settleReturn

  const schedule = {
    pullShapes: [],
    predShapes: [],
    returnShapes: [],
    predByPull: [],
    actions: [],
  };
  const modelTrace = [];
  const callResults = [];
  let ev;
  // Two names, one behaviour: both append to the action's trace in emission
  // order. The distinction documents intent -- emitSync marks an underlying
  // call observed synchronously, emitSettle a consumer-promise settlement
  // observed one microtask hop later -- which is what makes the emission order
  // faithful (see resolvePred's false branch for the one place it matters).
  const emitSync = (s) => ev.push(s);
  const emitSettle = (s) => ev.push(s);

  const settleNext = (callId, result) => {
    callResults[callId] = { type: 'next', rhs: fmtResult(result) };
    emitSettle(evNext(callId, fmtResult(result)));
  };
  const rejectNext = (callId, msg) => {
    callResults[callId] = { type: 'next', rhs: `throw ${msg}` };
    emitSettle(evNextThrow(callId, msg));
  };
  const settleReturn = (callId) => {
    callResults[callId] = { type: 'return', rhs: `{done:true}` };
    emitSettle(evReturn(callId, `{done:true}`));
  };

  const clearTerminalState = () => {
    nodes.length = 0;
    valueLimit = 0;
    terminalIndex = -Infinity;
  };

  const settleDoneFrom = (firstDone) => {
    firstDone = Math.min(firstDone, consumers.length);
    for (let i = firstDone; i < consumers.length; i++) {
      settleNext(consumers[i], { value: undefined, done: true });
    }
    consumers.length = firstDone;
    if (consumers.length === 0) clearTerminalState();
  };

  const pump = () => {
    while (consumers.length > 0 && nodes.length > 0) {
      const node = nodes[0];
      if (node.status === 'pending') break;
      if (node.status === 'value') {
        settleNext(consumers.shift(), { value: node.value, done: false });
        nodes.shift();
        valueLimit--;
      } else if (node.status === 'error') {
        nodes.shift();
        valueLimit--;
        if (node.heldForClose) {
          // A head error awaiting its source close: commit it to the head call
          // but defer the rejection until the close settles, without blocking the
          // values behind it.
          deferredError = { callId: consumers.shift(), error: node.error };
        } else {
          rejectNext(consumers.shift(), node.error);
        }
      } else {
        for (const callId of consumers) settleNext(callId, { value: undefined, done: true });
        consumers.length = 0;
        clearTerminalState();
        return;
      }
    }
  };

  // One-shot delivery interleaving. When a false predicate frees the head slot
  // it both issues a replacement pull *and* unblocks a buffered value. The real
  // implementation observes that unblocked delivery one hop after resolving it,
  // which lands *after* the replacement pull's first predicate call but *before*
  // that predicate's result is processed (a close, a nested pull, or its own
  // delivery). invokePred fires this at exactly that point; the false path fires
  // it afterward if the replacement never reached a synchronous predicate call.
  let pendingDelivery = false;
  const firePendingDelivery = () => {
    if (!pendingDelivery) return;
    pendingDelivery = false;
    if (nodes.length > 0 && consumers.length > 0) pump();
  };

  const canIssueReplacement = () => !done && nextPullId < maxPulls;

  const closeForPredicateError = (node) => {
    done = true;
    terminalIndex = nextPullId - 1;
    const id = nextReturnId++;
    const shape = RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
    schedule.returnShapes[id] = shape;
    emitSync(evUReturn(id));
    // The error must not be surfaced until this it.return() settles. A sync
    // close is already settled, so the error delivers immediately; a pending
    // close holds the erroring node until a settleReturn releases it.
    if (shape === 'pending') {
      pendingReturns.push({ id, heldNode: node });
      return true;
    }
    return false;
  };

  const failNode = (node, msg) => {
    node.status = 'error';
    node.error = msg;
    pump();
  };

  const issuePull = () => {
    const node = { status: 'pending', index: nextPullId, pullId: nextPullId, heldForClose: false };
    const pullId = nextPullId++;
    nodes.push(node);
    valueLimit++;
    const shape = PULL_SHAPES[chooser.choose(PULL_SHAPES.length)];
    schedule.pullShapes[pullId] = shape;
    emitSync(evUNext(pullId));
    if (shape === 'syncValue') resolvePull(node, 'value');
    else if (shape === 'syncDone') resolvePull(node, 'done');
    else if (shape === 'syncThrow') resolvePull(node, 'reject');
    else pendingPulls.push({ id: pullId, node });
  };

  const choosePredShape = () => {
    const shapes = PRED_SHAPES.filter((s) => s !== 'syncFalse' || canIssueReplacement() || done);
    return shapes[chooser.choose(shapes.length)];
  };

  const choosePredOutcomes = () => {
    return PRED_OUTCOMES.filter((o) => o !== 'false' || canIssueReplacement() || done);
  };

  function invokePred(node, arg) {
    const id = nextPredId++;
    const shape = choosePredShape();
    schedule.predShapes[id] = shape;
    schedule.predByPull[node.pullId] = id;
    emitSync(evPred(arg));
    firePendingDelivery();
    if (shape === 'syncTrue') resolvePred(node, arg, 'true');
    else if (shape === 'syncFalse') resolvePred(node, arg, 'false');
    else if (shape === 'syncThrow') resolvePred(node, arg, 'reject');
    else pendingPreds.push({ id, node, arg });
  }

  function resolvePull(node, outcome) {
    if (node.index > terminalIndex) return;
    if (outcome === 'value') {
      invokePred(node, pullValue(node.pullId));
    } else if (outcome === 'done') {
      // A done is the terminal wall regardless of whether the source finished on
      // its own or is draining an it.return() we issued: discard this position and
      // every later one, even one already settled with a value or an error.
      done = true;
      terminalIndex = node.index;
      node.status = 'done';
      valueLimit--;
      const idx = nodes.indexOf(node);
      for (let i = nodes.length - 1; i > idx; i--) {
        if (nodes[i].status !== 'done') valueLimit--;
        nodes.splice(i, 1);
      }
      pump();
      if (consumers.length > valueLimit) settleDoneFrom(valueLimit);
    } else {
      done = true;
      terminalIndex = Math.min(terminalIndex, nextPullId - 1);
      failNode(node, pullError(node.pullId));
    }
  }

  function resolvePred(node, arg, outcome) {
    if (node.index > terminalIndex) return;
    if (outcome === 'true') {
      node.status = 'value';
      node.value = arg;
      pump();
    } else if (outcome === 'false') {
      valueLimit--;
      const idx = nodes.indexOf(node);
      if (idx !== -1) nodes.splice(idx, 1);
      if (!done) {
        pendingDelivery = true;
        issuePull();
        firePendingDelivery();
      } else if (nodes.length > 0 && consumers.length > 0) {
        pump();
      }
      if (done && consumers.length > valueLimit) settleDoneFrom(valueLimit);
    } else {
      // A predicate error is the terminal event while the source is still live,
      // so it closes the source. The rejection must not be surfaced until that
      // it.return() settles, so a pending close holds this node (see pump).
      const held = !done && closeForPredicateError(node);
      node.heldForClose = held;
      failNode(node, predError(arg));
    }
  }

  const computeLegal = () => {
    // Force termination once the schedule reaches the event budget; any
    // in-flight pulls/predicates/returns are simply left unsettled.
    if (schedule.actions.length >= maxEvents) return [{ t: 'stop' }];
    const legal = [];
    legal.push({ t: 'next' });
    legal.push({ t: 'return' });
    for (const p of pendingPulls) for (const o of PULL_OUTCOMES) legal.push({ t: 'settlePull', id: p.id, o });
    for (const p of pendingPreds) {
      for (const o of choosePredOutcomes()) legal.push({ t: 'settlePred', id: p.id, o });
    }
    for (const r of pendingReturns) legal.push({ t: 'settleReturn', id: r.id });
    if (!pendingPulls.length && !pendingPreds.length && !pendingReturns.length) legal.push({ t: 'stop' });
    return legal;
  };

  let truncated = false;
  for (;;) {
    const legal = computeLegal();
    const act = legal[chooser.choose(legal.length)];
    schedule.actions.push(act);
    if (act.t === 'stop') {
      // A natural stop only happens once nothing is pending; a stop with work
      // still in flight is the event budget cutting the schedule short.
      truncated = pendingPulls.length > 0 || pendingPreds.length > 0 || pendingReturns.length > 0;
      break;
    }

    ev = [];
    if (act.t === 'next') {
      const callId = callCount++;
      if (done) settleNext(callId, { value: undefined, done: true });
      else {
        consumers.push(callId);
        issuePull();
      }
    } else if (act.t === 'return') {
      const callId = callCount++;
      if (done) settleReturn(callId);
      else {
        done = true;
        const id = nextReturnId++;
        const shape = RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
        schedule.returnShapes[id] = shape;
        emitSync(evUReturn(id));
        if (shape === 'sync') settleReturn(callId);
        else pendingReturns.push({ id, callId });
      }
    } else if (act.t === 'settlePull') {
      const idx = pendingPulls.findIndex((p) => p.id === act.id);
      const p = pendingPulls[idx];
      pendingPulls.splice(idx, 1);
      resolvePull(p.node, act.o);
    } else if (act.t === 'settlePred') {
      const idx = pendingPreds.findIndex((p) => p.id === act.id);
      const p = pendingPreds[idx];
      pendingPreds.splice(idx, 1);
      resolvePred(p.node, p.arg, act.o);
    } else if (act.t === 'settleReturn') {
      const idx = pendingReturns.findIndex((r) => r.id === act.id);
      const r = pendingReturns[idx];
      pendingReturns.splice(idx, 1);
      if (r.heldNode) {
        // An internal predicate-error close settling. If the error already
        // reached the head and was committed to a call, reject it now; otherwise
        // it is still behind a pending position and will be delivered in order
        // once it reaches the head (heldForClose is now clear).
        r.heldNode.heldForClose = false;
        if (deferredError) {
          const { callId, error } = deferredError;
          deferredError = null;
          rejectNext(callId, error);
        }
        pump();
        if (done && consumers.length > valueLimit) settleDoneFrom(valueLimit);
      } else {
        settleReturn(r.callId);
      }
    }
    modelTrace.push(ev.slice());
  }

  return { schedule, modelTrace, callResults, truncated, numDecisions: chooser.i, frontierOptionCount: chooser.frontierOptionCount, decisions: chooser.decisions };
}

function* enumerate(maxEvents) {
  const worklist = [[]];
  while (worklist.length) {
    const V = worklist.pop();
    const r = runModel(maxEvents, new Chooser(V));
    if (r.numDecisions === V.length) yield r;
    else for (let a = 0; a < r.frontierOptionCount; a++) worklist.push([...V, a]);
  }
}

function runReal(schedule) {
  let cur = [];
  const log = (s) => cur.push(s);

  const pendingPulls = new Map();
  const pendingPreds = new Map();
  const pendingReturns = new Map();
  let nextPullId = 0, nextPredId = 0, nextReturnId = 0;
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

  const pred = (arg) => {
    const id = nextPredId++;
    log(evPred(arg));
    const shape = schedule.predShapes[id];
    if (shape === undefined) { log(`!! unexpected ${evPred(arg)}#${id}`); return false; }
    if (shape === 'syncTrue') return true;
    if (shape === 'syncFalse') return false;
    if (shape === 'syncThrow') throw new Error(predError(arg));
    const d = Promise.withResolvers();
    pendingPreds.set(id, { d, arg });
    return d.promise;
  };

  const filteredIt = filter(source, pred);
  const realTrace = [];
  let callCount = 0;

  const trackNext = (callId, p) => p.then(
    (r) => log(evNext(callId, fmtResult(r))),
    (e) => log(evNextThrow(callId, e && e.message)),
  );
  const trackReturn = (callId, p) => p.then(
    (r) => log(evReturn(callId, fmtResult(r))),
    (e) => log(evReturnThrow(callId, e && e.message)),
  );

  return (async () => {
    for (const act of schedule.actions) {
      if (act.t === 'stop') break;
      cur = [];
      if (act.t === 'next') {
        const callId = callCount++;
        try { trackNext(callId, Promise.resolve(filteredIt.next())); }
        catch (e) { log(evNextThrow(callId, e && e.message)); }
      } else if (act.t === 'return') {
        const callId = callCount++;
        try { trackReturn(callId, Promise.resolve(filteredIt.return())); }
        catch (e) { log(evReturnThrow(callId, e && e.message)); }
      } else if (act.t === 'settlePull') {
        const d = pendingPulls.get(act.id);
        if (!d) log(`!! settlePull#${act.id} not pending`);
        else {
          pendingPulls.delete(act.id);
          if (act.o === 'value') d.resolve({ value: pullValue(act.id), done: false });
          else if (act.o === 'done') d.resolve({ value: undefined, done: true });
          else { underlyingErrored = true; d.reject(new Error(pullError(act.id))); }
        }
      } else if (act.t === 'settlePred') {
        const p = pendingPreds.get(act.id);
        if (!p) log(`!! settlePred#${act.id} not pending`);
        else {
          pendingPreds.delete(act.id);
          if (act.o === 'true') p.d.resolve(true);
          else if (act.o === 'false') p.d.resolve(false);
          else p.d.reject(new Error(predError(p.arg)));
        }
      } else if (act.t === 'settleReturn') {
        const d = pendingReturns.get(act.id);
        if (!d) log(`!! settleReturn#${act.id} not pending`);
        else { pendingReturns.delete(act.id); d.resolve({ value: undefined, done: true }); }
      }
      await flush(() => cur.length);
      realTrace.push(cur.slice());
    }
    return { realTrace, invariantViolation };
  })();
}

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

function predOutcome(schedule, predId) {
  const shape = schedule.predShapes[predId];
  if (shape === 'syncTrue') return 'true';
  if (shape === 'syncFalse') return 'false';
  if (shape === 'syncThrow') return 'reject';
  const a = schedule.actions.find((x) => x.t === 'settlePred' && x.id === predId);
  return a.o;
}

function isErrorFree(schedule) {
  if (schedule.predShapes.includes('syncThrow')) return false;
  if (pullOutcomeKinds(schedule).includes('error')) return false;
  if (schedule.actions.some((a) => a.t === 'settlePred' && a.o === 'reject')) return false;
  return true;
}

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

function checkSequentialProperty(schedule, callResults) {
  if (!isWellBehaved(schedule)) return null;
  const kinds = pullOutcomeKinds(schedule);
  let done = false;
  let pi = 0;
  let callId = 0;
  for (const act of schedule.actions) {
    if (act.t !== 'next' && act.t !== 'return') continue;
    let expectedRhs;
    if (act.t === 'return') {
      done = true;
      expectedRhs = `{done:true}`;
    } else if (done) {
      expectedRhs = `{done:true}`;
    } else {
      for (;;) {
        if (pi >= kinds.length) return null;
        if (kinds[pi] === 'done') {
          done = true;
          pi++;
          expectedRhs = `{done:true}`;
          break;
        }
        const predId = schedule.predByPull[pi];
        if (predId === undefined) return null;
        const po = predOutcome(schedule, predId);
        const value = pullValue(pi);
        pi++;
        if (po === 'true') {
          expectedRhs = `{value:${value},done:false}`;
          break;
        }
      }
    }
    const actual = callResults[callId];
    if (!actual || actual.rhs !== expectedRhs) {
      return { callId, expectedRhs, actualRhs: actual ? actual.rhs : '(none)' };
    }
    callId++;
  }
  return null;
}

function compareTraces(model, real) {
  if (model.length !== real.length) return { kind: 'length', model: model.length, real: real.length };
  for (let i = 0; i < model.length; i++) {
    const m = model[i], r = real[i];
    let same = m.length === r.length;
    for (let j = 0; same && j < m.length; j++) if (m[j] !== r[j]) same = false;
    if (!same) return { kind: 'step', step: i, model: m, real: r };
  }
  return null;
}

// Oracle-independent sanity check over the *real* trace: assert the necessary
// happens-before edges that any correct run must satisfy, without trusting the
// oracle's predicted ordering. A predicate can't be called on a value before
// that value is pulled, and a value can't be delivered before its predicate
// accepts it. Cheap, but it catches gross ordering errors the oracle and impl
// might agree on; set NO_PARTIAL_ORDER=1 to skip it for speed.
function checkPartialOrder(realTrace) {
  const flat = [];
  for (const step of realTrace) for (const label of step) flat.push(label);
  for (let i = 0; i < flat.length; i++) {
    const label = flat[i];
    const mPred = /^pred\(P(\d+)\)$/.exec(label);
    if (mPred) {
      const callIdx = flat.indexOf(`U.next#${mPred[1]}`);
      if (callIdx === -1 || callIdx > i) {
        return { kind: 'pred-before-pull', label, at: i, dep: `U.next#${mPred[1]}`, depAt: callIdx };
      }
    }
    const mVal = /^next#\d+ -> \{value:P(\d+),done:false\}$/.exec(label);
    if (mVal) {
      const predIdx = flat.indexOf(`pred(P${mVal[1]})`);
      if (predIdx === -1 || predIdx > i) {
        return { kind: 'value-before-pred', label, at: i, dep: `pred(P${mVal[1]})`, depAt: predIdx };
      }
    }
  }
  return null;
}

function countSchedules(maxEvents) {
  const byLen = new Map();
  let total = 0;
  for (const s of enumerate(maxEvents)) {
    total++;
    const len = s.schedule.actions.length;
    byLen.set(len, (byLen.get(len) ?? 0) + 1);
  }
  console.log(`N = ${maxEvents}; total schedules: ${total}`);
  let cum = 0;
  for (const len of [...byLen.keys()].sort((a, b) => a - b)) {
    cum += byLen.get(len);
    console.log(`  len ${String(len).padStart(2)}: ${String(byLen.get(len)).padStart(8)}  (cumulative ${cum})`);
  }
}

// Run every check against one schedule, reporting the first failure. Returns
// true on pass, false on failure (after printing the report). Shared by the
// exhaustive, fuzz, and replay drivers so they all apply the identical oracle.
async function checkSchedule(s, caseLabel) {
  const { realTrace, invariantViolation } = await runReal(s.schedule);
  const diff = compareTraces(s.modelTrace, realTrace);
  if (diff) { reportTraceFailure(s, realTrace, diff, caseLabel); return false; }
  if (invariantViolation) { reportInvariantFailure(s, invariantViolation, caseLabel); return false; }
  // A truncated schedule leaves some next()/return() calls unsettled, so the
  // sequential spec (which expects every call to resolve) does not apply; the
  // exact-trace comparison above is still the oracle for these.
  const prop = s.truncated ? null : checkSequentialProperty(s.schedule, s.callResults);
  if (prop) { reportPropertyFailure(s, prop, caseLabel); return false; }
  if (CHECK_PARTIAL_ORDER) {
    const po = checkPartialOrder(realTrace);
    if (po) { reportPartialOrderFailure(s, po, caseLabel); return false; }
  }
  return true;
}

async function runExhaustive(maxEvents) {
  let scheduleCount = 0;
  for (const s of enumerate(maxEvents)) {
    scheduleCount++;
    if (!(await checkSchedule(s, scheduleCount))) {
      process.exitCode = 1;
      return;
    }
  }
  console.log('');
  console.log(`N = ${maxEvents} (max events)`);
  console.log(`schedules explored: ${scheduleCount}`);
  console.log('all schedules passed');
}

async function runFuzz(maxEvents, count, seedArg) {
  // Per-case seeding (rather than one shared stream) so case i is reproducible
  // independently of `count` and of the cases before it: a failing run prints
  // its base seed, and re-running with that --seed regenerates the same cases.
  const baseSeed = seedArg !== undefined ? (Number(seedArg) >>> 0) : (Math.floor(Math.random() * 2 ** 32) >>> 0);
  console.log(`fuzzing N = ${maxEvents}; cases = ${count}; seed = ${baseSeed}`);
  for (let i = 0; i < count; i++) {
    const rng = mulberry32((baseSeed + Math.imul(i, 0x9e3779b9)) >>> 0);
    const s = runModel(maxEvents, new RandomChooser(rng));
    if (!(await checkSchedule(s, `fuzz #${i} (seed ${baseSeed})`))) {
      console.log(`  replay with: node ${process.argv[1]} ${maxEvents} --replay '${JSON.stringify(s.decisions)}'`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('');
  console.log(`N = ${maxEvents} (max events)`);
  console.log(`fuzz cases run: ${count} (seed ${baseSeed})`);
  console.log('all fuzz cases passed');
}

async function runReplay(maxEvents, decisions) {
  const s = runModel(maxEvents, new Chooser(decisions));
  console.log('replaying decisions: ' + JSON.stringify(decisions));
  console.log('schedule: ' + describeSchedule(s));
  if (await checkSchedule(s, 'replay')) console.log('replay passed (no mismatch)');
  else process.exitCode = 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fuzz: { type: 'string' },   // number of random cases to run
      seed: { type: 'string' },   // base PRNG seed for --fuzz (default: random)
      replay: { type: 'string' }, // JSON decision vector printed by a fuzz failure
    },
  });
  const maxEvents = Number(positionals[0] ?? 3);
  setFlushChunk(Math.max(8, 2 * maxEvents));
  if (process.env.COUNT) return countSchedules(maxEvents);
  if (values.replay !== undefined) return runReplay(maxEvents, JSON.parse(values.replay));
  if (values.fuzz !== undefined) return runFuzz(maxEvents, Number(values.fuzz), values.seed);
  return runExhaustive(maxEvents);
}

function describeSchedule(s) {
  return s.schedule.actions.map(actionLabel).join('  ');
}

function reportTraceFailure(s, realTrace, diff, caseLabel) {
  console.log('TRACE MISMATCH');
  console.log(`  case: ${caseLabel}`);
  console.log('  schedule: ' + describeSchedule(s));
  console.log('  pullShapes:   ' + JSON.stringify(s.schedule.pullShapes));
  console.log('  predShapes:   ' + JSON.stringify(s.schedule.predShapes));
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

function reportInvariantFailure(s, violation, caseLabel) {
  console.log('INVARIANT VIOLATION');
  console.log(`  case: ${caseLabel}`);
  console.log('  schedule: ' + describeSchedule(s));
  console.log('  ' + violation);
  console.log('');
}

function reportPropertyFailure(s, prop, caseLabel) {
  console.log('PROPERTY VIOLATION (oracle disagrees with sequential spec)');
  console.log(`  case: ${caseLabel}`);
  console.log('  schedule: ' + describeSchedule(s));
  console.log(`  call #${prop.callId}: expected ${prop.expectedRhs}, oracle gave ${prop.actualRhs}`);
  console.log('');
}

function reportPartialOrderFailure(s, po, caseLabel) {
  console.log('PARTIAL-ORDER VIOLATION (real trace breaks a happens-before premise)');
  console.log(`  case: ${caseLabel}`);
  console.log('  schedule: ' + describeSchedule(s));
  if (po.kind === 'pred-before-pull') {
    console.log(`  "${po.label}" (index ${po.at}) precedes its pull "${po.dep}" (index ${po.depAt})`);
  } else if (po.kind === 'value-before-pred') {
    console.log(`  "${po.label}" (index ${po.at}) precedes its predicate "${po.dep}" (index ${po.depAt})`);
  }
  console.log('');
}

main();

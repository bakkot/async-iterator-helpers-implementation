// Bounded-exhaustive differential test for the concurrent `filter`.
//
// Usage: `node test/filter-bounded-exhaustive.js [N]`   (default N = 2)
//
// N bounds consumer calls. Unlike map, filter can issue replacement pulls when
// predicates return false, so this also bounds total underlying pulls to 2N.

import { filter } from '../filter.js';

const FLUSH_ROUNDS = 20;
const flush = async () => { for (let i = 0; i < FLUSH_ROUNDS; i++) await Promise.resolve(); };

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

function runModel(N, chooser) {
  const maxPulls = Math.max(1, 2 * N);
  let done = false;
  let budget = N;
  let callCount = 0;
  let nextPullId = 0, nextPredId = 0, nextReturnId = 0;
  let terminalIndex = Infinity;

  const nodes = [];     // retained pull slots, in pull order
  const consumers = []; // pending next() call ids, in call order
  let valueLimit = 0;   // pending/value/error slots before the terminal wall

  const pendingPulls = [];   // { id, node }
  const pendingPreds = [];   // { id, node, arg }
  const pendingReturns = []; // explicit return() calls only

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
        rejectNext(consumers.shift(), node.error);
        nodes.shift();
        valueLimit--;
      } else {
        for (const callId of consumers) settleNext(callId, { value: undefined, done: true });
        consumers.length = 0;
        clearTerminalState();
        return;
      }
    }
  };

  const canIssueReplacement = () => !done && nextPullId < maxPulls;

  const closeForPredicateError = () => {
    done = true;
    terminalIndex = nextPullId - 1;
    const id = nextReturnId++;
    const shape = RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
    schedule.returnShapes[id] = shape;
    ev.push(evUReturn(id));
    // filter's close is fire-and-forget; predicate rejection is not delayed by
    // a pending underlying return().
  };

  const failNode = (node, msg) => {
    node.status = 'error';
    node.error = msg;
    pump();
  };

  const issuePull = () => {
    const node = { status: 'pending', index: nextPullId, pullId: nextPullId };
    const pullId = nextPullId++;
    nodes.push(node);
    valueLimit++;
    const shape = PULL_SHAPES[chooser.choose(PULL_SHAPES.length)];
    schedule.pullShapes[pullId] = shape;
    ev.push(evUNext(pullId));
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
    ev.push(evPred(arg));
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
      if (!done) issuePull();
      if (nodes.length > 0 && consumers.length > 0) pump();
      if (done && consumers.length > valueLimit) settleDoneFrom(valueLimit);
    } else {
      if (!done) closeForPredicateError();
      failNode(node, predError(arg));
    }
  }

  const computeLegal = () => {
    const legal = [];
    if (budget > 0) {
      legal.push({ t: 'next' });
      legal.push({ t: 'return' });
    }
    for (const p of pendingPulls) for (const o of PULL_OUTCOMES) legal.push({ t: 'settlePull', id: p.id, o });
    for (const p of pendingPreds) {
      for (const o of choosePredOutcomes()) legal.push({ t: 'settlePred', id: p.id, o });
    }
    for (const r of pendingReturns) legal.push({ t: 'settleReturn', id: r.id });
    if (!pendingPulls.length && !pendingPreds.length && !pendingReturns.length) legal.push({ t: 'stop' });
    return legal;
  };

  for (;;) {
    const legal = computeLegal();
    const act = legal[chooser.choose(legal.length)];
    schedule.actions.push(act);
    if (act.t === 'stop') break;

    ev = [];
    if (act.t === 'next') {
      const callId = callCount++;
      budget--;
      if (done) settleNext(callId, { value: undefined, done: true });
      else {
        consumers.push(callId);
        issuePull();
      }
    } else if (act.t === 'return') {
      const callId = callCount++;
      budget--;
      if (done) settleReturn(callId);
      else {
        done = true;
        const id = nextReturnId++;
        const shape = RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
        schedule.returnShapes[id] = shape;
        ev.push(evUReturn(id));
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
      settleReturn(r.callId);
    }
    modelTrace.push(ev.slice().sort());
  }

  return { schedule, modelTrace, callResults, numDecisions: chooser.i, frontierOptionCount: chooser.frontierOptionCount };
}

function* enumerate(N) {
  const worklist = [[]];
  while (worklist.length) {
    const V = worklist.pop();
    const r = runModel(N, new Chooser(V));
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
      await flush();
      realTrace.push(cur.slice().sort());
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
    if (model[i].join(' | ') !== real[i].join(' | ')) {
      return { kind: 'step', step: i, model: model[i], real: real[i] };
    }
  }
  return null;
}

async function main() {
  const N = Number(process.argv[2] ?? 2);
  let scheduleCount = 0;

  for (const s of enumerate(N)) {
    scheduleCount++;
    const { realTrace, invariantViolation } = await runReal(s.schedule);
    const diff = compareTraces(s.modelTrace, realTrace);
    if (diff) {
      reportTraceFailure(s, realTrace, diff, scheduleCount);
      process.exitCode = 1;
      return;
    }
    if (invariantViolation) {
      reportInvariantFailure(s, invariantViolation, scheduleCount);
      process.exitCode = 1;
      return;
    }
    const prop = checkSequentialProperty(s.schedule, s.callResults);
    if (prop) {
      reportPropertyFailure(s, prop, scheduleCount);
      process.exitCode = 1;
      return;
    }
  }

  console.log('');
  console.log(`N = ${N}`);
  console.log(`schedules explored: ${scheduleCount}`);
  console.log('all schedules passed');
}

function describeSchedule(s) {
  return s.schedule.actions.map(actionLabel).join('  ');
}

function reportTraceFailure(s, realTrace, diff, scheduleCount) {
  console.log('TRACE MISMATCH');
  console.log(`  after schedules explored: ${scheduleCount}`);
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

function reportInvariantFailure(s, violation, scheduleCount) {
  console.log('INVARIANT VIOLATION');
  console.log(`  after schedules explored: ${scheduleCount}`);
  console.log('  schedule: ' + describeSchedule(s));
  console.log('  ' + violation);
  console.log('');
}

function reportPropertyFailure(s, prop, scheduleCount) {
  console.log('PROPERTY VIOLATION (oracle disagrees with sequential spec)');
  console.log(`  after schedules explored: ${scheduleCount}`);
  console.log('  schedule: ' + describeSchedule(s));
  console.log(`  call #${prop.callId}: expected ${prop.expectedRhs}, oracle gave ${prop.actualRhs}`);
  console.log('');
}

main();

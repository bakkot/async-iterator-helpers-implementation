import { filter } from "../filter.js";

const MAX_EVENT_COUNT = 5;

const PREDICATE_OUTCOMES = ["pending", "true", "false", "throw"];
const SOURCE_OUTCOMES = ["pending", "done", "throw", "value"];

function eventLabel(event) {
  if (event.type === "settle source next value") {
    return `${event.type} ${event.id} ${event.value} predicate ${event.predicate}${sourceOutcomeLabel(event.source)}`;
  }
  if (event.type === "call next") {
    return `${event.type} ${event.id}${sourceOutcomeLabel(event.source)}`;
  }
  if (event.type === "settle predicate") {
    return `${event.type} ${event.id} ${event.accepted}${sourceOutcomeLabel(event.source)}`;
  }
  return event.id === undefined ? event.type : `${event.type} ${event.id}`;
}

function valueForId(id) {
  return `v${id}`;
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertArrayEqual(actual, expected, message) {
  if (actual.length !== expected.length) {
    throw new AssertionError(
      `${message}: length expected ${expected.length}, got ${actual.length}\n` +
        diffLines(actual, expected),
    );
  }

  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new AssertionError(
        `${message}: first difference at ${index}\n` + diffLines(actual, expected),
      );
    }
  }
}

function sequenceLabel(sequence) {
  return `[${sequence.map((event) => JSON.stringify(eventLabel(event))).join(",")}]`;
}

function sourceValueEvents(type, id, value) {
  return PREDICATE_OUTCOMES.map((predicate) => ({ type, id, value, predicate }));
}

function sourceOutcomeLabel(source) {
  if (source === undefined) {
    return "";
  }
  if (source.type === "value") {
    return ` source ${source.type} ${source.value} predicate ${source.predicate}`;
  }
  return ` source ${source.type}`;
}

function sourceOutcomes(value) {
  const outcomes = [
    { type: "pending" },
    { type: "done" },
    { type: "throw" },
  ];
  for (const predicate of PREDICATE_OUTCOMES) {
    outcomes.push({ type: "value", value, predicate });
  }
  return outcomes;
}

function withSourceOutcomes(base, value) {
  return sourceOutcomes(value).map((source) => ({ ...base, source }));
}

function diffLines(actual, expected) {
  const length = Math.max(actual.length, expected.length);
  const lines = [];
  for (let index = 0; index < length; index += 1) {
    if (actual[index] !== expected[index]) {
      lines.push(`  ${index}: actual=${actual[index]} expected=${expected[index]}`);
    }
  }
  return lines.slice(0, 20).join("\n");
}

function* eventSequences(maxLength, prefix = [], state = createGenerationState()) {
  yield prefix;

  if (prefix.length === maxLength) {
    return;
  }

  for (const event of coherentEvents(state)) {
    const nextState = applyGenerationEvent(state, event);
    prefix.push(event);
    yield* eventSequences(maxLength, prefix, nextState);
    prefix.pop();
  }
}

function createGenerationState() {
  return stabilizeGenerationState({
    nextSourceOutcome: null,
    nextSourceId: 0,
    nextPredicateId: 0,
    nextResultNextId: 0,
    nextResultReturnId: 0,
    nextValueId: 0,
    nextSourceReturnId: 0,
    nextRequests: 0,
    returned: false,
    stopped: false,
    doneSourceId: null,
    fatal: false,
    sourceItems: [],
    sourceById: [],
    predicateById: [],
    firstUnconsumedIndex: 0,
  });
}

function cloneGenerationState(state) {
  const sourceItems = state.sourceItems.map((item) => ({ ...item }));
  const sourceById = [];
  const predicateById = [];

  for (const item of sourceItems) {
    sourceById[item.sourceId] = item;
    if (item.predicateId !== undefined) {
      predicateById[item.predicateId] = item;
    }
  }

  return {
    nextSourceOutcome: state.nextSourceOutcome,
    nextSourceId: state.nextSourceId,
    nextPredicateId: state.nextPredicateId,
    nextResultNextId: state.nextResultNextId,
    nextResultReturnId: state.nextResultReturnId,
    nextValueId: state.nextValueId,
    nextSourceReturnId: state.nextSourceReturnId,
    nextRequests: state.nextRequests,
    returned: state.returned,
    stopped: state.stopped,
    doneSourceId: state.doneSourceId,
    fatal: state.fatal,
    sourceItems,
    sourceById,
    predicateById,
    firstUnconsumedIndex: state.firstUnconsumedIndex,
  };
}

function coherentEvents(state) {
  const events = [];
  const callNext = { type: "call next", id: state.nextResultNextId };
  if (generationCallNextWillPull(state)) {
    events.push(...withSourceOutcomes(callNext, valueForId(state.nextValueId)));
  } else {
    events.push(callNext);
  }
  events.push({ type: "call return", id: state.nextResultReturnId });

  for (const item of state.sourceItems) {
    if (item.state === "pending-source") {
      for (const event of sourceValueEvents("settle source next value", item.sourceId, valueForId(state.nextValueId))) {
        if (event.predicate === "false" && generationFalsePredicateWillPull(state, item)) {
          events.push(...withSourceOutcomes(event, valueForId(state.nextValueId + 1)));
        } else {
          events.push(event);
        }
      }
      events.push({ type: "settle source next done", id: item.sourceId });
      events.push({ type: "reject source next", id: item.sourceId });
    }
    if (item.state === "pending-predicate") {
      events.push({ type: "settle predicate", id: item.predicateId, accepted: true });
      const falseEvent = { type: "settle predicate", id: item.predicateId, accepted: false };
      if (generationFalsePredicateWillPull(state, item)) {
        events.push(...withSourceOutcomes(falseEvent, valueForId(state.nextValueId)));
      } else {
        events.push(falseEvent);
      }
      events.push({ type: "reject predicate", id: item.predicateId });
    }
  }

  return events;
}

function applyGenerationEvent(previousState, event) {
  const state = cloneGenerationState(previousState);

  if (event.type === "call next") {
    state.nextResultNextId += 1;
    if (!state.returned && !state.fatal) {
      state.nextSourceOutcome = event.source ?? null;
      if (event.source?.type === "value") {
        state.nextValueId += 1;
      }
      state.nextRequests += 1;
    }
    return stabilizeGenerationState(state);
  }

  if (event.type === "call return") {
    state.nextResultReturnId += 1;
    state.returned = true;
    return stabilizeGenerationState(state);
  }

  const item = event.type.includes("source next")
    ? state.sourceById[event.id]
    : state.predicateById[event.id];

  if (generationShouldIgnoreItem(state, item)) {
    item.state = "ignored";
    return stabilizeGenerationState(state);
  }

  if (event.type === "settle source next value") {
    state.nextValueId += 1;
    if (event.predicate === "false") {
      state.nextSourceOutcome = event.source ?? null;
      if (event.source?.type === "value") {
        state.nextValueId += 1;
      }
    }
    callGenerationPredicate(state, item, event.predicate);
  } else if (event.type === "settle source next done") {
    item.state = "done";
    state.stopped = true;
    state.doneSourceId =
      state.doneSourceId === null ? item.sourceId : Math.min(state.doneSourceId, item.sourceId);
  } else if (event.type === "reject source next") {
    item.state = "error";
    state.fatal = true;
  } else if (event.type === "settle predicate") {
    if (!event.accepted) {
      state.nextSourceOutcome = event.source ?? null;
      if (event.source?.type === "value") {
        state.nextValueId += 1;
      }
    }
    item.state = event.accepted ? "accepted" : "rejected";
  } else if (event.type === "reject predicate") {
    item.state = "error";
    state.fatal = true;
    state.returned = true;
    state.nextSourceReturnId += 1;
  } else {
    throw new Error(`unknown generation event: ${eventLabel(event)}`);
  }

  return stabilizeGenerationState(state);
}

function stabilizeGenerationState(state) {
  let changed = true;
  while (changed) {
    changed = false;

    if (
      !state.returned &&
      !state.stopped &&
      !state.fatal &&
      generationActiveSearchCount(state) < state.nextRequests
    ) {
      markGenerationReplacedRejected(state);
      pullGenerationSource(state);
      changed = true;
    }

    if (drainGenerationState(state)) {
      changed = true;
    }
  }
  return state;
}

function generationActiveSearchCount(state) {
  let count = 0;
  for (const item of state.sourceItems) {
    if (
      !item.consumed &&
      (item.state === "pending-source" ||
        item.state === "pending-predicate" ||
        item.state === "accepted" ||
        item.state === "error")
    ) {
      count += 1;
    }
  }
  return count;
}

function pullGenerationSource(state) {
  const item = {
    sourceId: state.nextSourceId,
    predicateId: undefined,
    state: "pending-source",
    consumed: false,
    replaced: false,
  };
  state.nextSourceId += 1;
  state.sourceItems.push(item);
  state.sourceById[item.sourceId] = item;

  if (state.nextSourceOutcome === null) {
    return;
  }

  const plan = state.nextSourceOutcome;
  state.nextSourceOutcome = null;
  if (plan.type === "pending") {
    return;
  }
  if (plan.type === "value") {
    callGenerationPredicate(state, item, plan.predicate);
  } else if (plan.type === "done") {
    item.state = "done";
    state.stopped = true;
    state.doneSourceId =
      state.doneSourceId === null ? item.sourceId : Math.min(state.doneSourceId, item.sourceId);
  } else if (plan.type === "throw") {
    item.state = "error";
    state.fatal = true;
    state.returned = true;
    state.nextSourceReturnId += 1;
  }
}

function callGenerationPredicate(state, item, outcome) {
  item.predicateId = state.nextPredicateId;
  state.nextPredicateId += 1;
  state.predicateById[item.predicateId] = item;

  if (outcome === "pending") {
    item.state = "pending-predicate";
    return;
  }

  if (outcome === "true") {
    item.state = "accepted";
  } else if (outcome === "false") {
    item.state = "rejected";
  } else if (outcome === "throw") {
    item.state = "error";
    state.fatal = true;
    state.returned = true;
    state.nextSourceReturnId += 1;
  } else {
    throw new Error(`unknown predicate outcome: ${outcome}`);
  }
}

function drainGenerationState(state) {
  let changed = false;
  let firstUnconsumed = firstGenerationUnconsumed(state);

  while (firstUnconsumed && state.nextRequests > 0) {
    if (firstUnconsumed.state === "ignored") {
      firstUnconsumed.consumed = true;
      state.firstUnconsumedIndex += 1;
      firstUnconsumed = firstGenerationUnconsumed(state);
      changed = true;
      continue;
    }

    if (firstUnconsumed.state === "rejected") {
      firstUnconsumed.consumed = true;
      state.firstUnconsumedIndex += 1;
      if ((state.returned || state.stopped) && !state.fatal && !firstUnconsumed.replaced) {
        state.nextRequests -= 1;
      }
      firstUnconsumed = firstGenerationUnconsumed(state);
      changed = true;
      continue;
    }

    if (firstUnconsumed.state === "accepted") {
      firstUnconsumed.consumed = true;
      state.nextRequests -= 1;
      state.firstUnconsumedIndex += 1;
      firstUnconsumed = firstGenerationUnconsumed(state);
      changed = true;
      continue;
    }

    if (firstUnconsumed.state === "done") {
      state.stopped = true;
      state.nextRequests = 0;
      return true;
    }

    if (firstUnconsumed.state === "error") {
      firstUnconsumed.consumed = true;
      state.nextRequests -= 1;
      state.firstUnconsumedIndex += 1;
      firstUnconsumed = firstGenerationUnconsumed(state);
      changed = true;
      continue;
    }

    const done = firstGenerationDone(state);
    if (done) {
      const requestsBeforeDone = generationOpenResultSlotsBefore(state, done);
      if (state.nextRequests > requestsBeforeDone) {
        state.nextRequests = requestsBeforeDone;
        return true;
      }
    }

    return changed;
  }

  return changed;
}

function markGenerationReplacedRejected(state) {
  for (const item of state.sourceItems) {
    if (!item.consumed && item.state === "rejected" && !item.replaced) {
      item.replaced = true;
      return;
    }
  }
}

function generationShouldIgnoreItem(state, item) {
  return state.doneSourceId !== null && item.sourceId > state.doneSourceId;
}

function generationCallNextWillPull(state) {
  return (
    !state.returned &&
    !state.stopped &&
    !state.fatal &&
    generationActiveSearchCount(state) < state.nextRequests + 1
  );
}

function generationFalsePredicateWillPull(state, item) {
  return (
    !state.returned &&
    !state.stopped &&
    !state.fatal &&
    !generationShouldIgnoreItem(state, item) &&
    generationActiveSearchCount(state) - 1 < state.nextRequests
  );
}

function firstGenerationDone(state) {
  for (const item of state.sourceItems) {
    if (!item.consumed && item.state === "done") {
      return item;
    }
  }
  return undefined;
}

function generationOpenResultSlotsBefore(state, target) {
  let count = 0;
  for (const item of state.sourceItems) {
    if (item === target) {
      return count;
    }
    if (
      !item.consumed &&
      item.state !== "ignored" &&
      item.state !== "rejected" &&
      item.sourceId < target.sourceId
    ) {
      count += 1;
    }
  }
  return count;
}

function firstGenerationUnconsumed(state) {
  while (
    state.firstUnconsumedIndex < state.sourceItems.length &&
    state.sourceItems[state.firstUnconsumedIndex].consumed
  ) {
    state.firstUnconsumedIndex += 1;
  }

  return state.sourceItems[state.firstUnconsumedIndex];
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function thrownValue(kind, id) {
  return `${kind} throw ${id}`;
}

function rejectedValue(kind, id) {
  return `${kind} reject ${id}`;
}

function observedValue(value) {
  return String(value);
}

function createHarness(filterImplementation) {
  let nextCallId = 0;
  let returnCallId = 0;
  let predicateCallId = 0;
  let resultNextId = 0;
  let resultReturnId = 0;
  let nextSourceOutcome = null;
  let predicateSyncPlan = null;
  const pendingSourceNext = [];
  const pendingPredicate = [];
  let pendingSourceNextCount = 0;
  let pendingPredicateCount = 0;
  const log = [];

  const source = {
    next() {
      const id = nextCallId;
      nextCallId += 1;
      log.push(`source.next ${id}`);

      if (nextSourceOutcome !== null) {
        const plan = nextSourceOutcome;
        nextSourceOutcome = null;

        if (plan.type === "value") {
          log.push(`source.next ${id} returned value ${plan.value}`);
          predicateSyncPlan = plan.predicate === "pending" ? null : plan.predicate;
          return { value: plan.value, done: false };
        }
        if (plan.type === "done") {
          log.push(`source.next ${id} returned done`);
          return { value: undefined, done: true };
        }
        if (plan.type === "throw") {
          const reason = thrownValue("source", id);
          log.push(`source.next ${id} threw ${reason}`);
          throw reason;
        }
      }

      const deferred = createDeferred();
      pendingSourceNext[id] = { id, deferred };
      pendingSourceNextCount += 1;
      log.push(`source.next ${id} returned pending`);
      return deferred.promise;
    },
    return() {
      const id = returnCallId;
      returnCallId += 1;
      log.push(`source.return ${id}`);
      return { value: undefined, done: true };
    },
  };

  function predicate(value) {
    const id = predicateCallId;
    predicateCallId += 1;
    log.push(`predicate ${id} called with ${value}`);

    if (predicateSyncPlan !== null) {
      const plan = predicateSyncPlan;
      predicateSyncPlan = null;

      if (plan === "true") {
        log.push(`predicate ${id} returned true`);
        return true;
      }
      if (plan === "false") {
        log.push(`predicate ${id} returned false`);
        return false;
      }
      const reason = thrownValue("predicate", id);
      log.push(`predicate ${id} threw ${reason}`);
      throw reason;
    }

    const deferred = createDeferred();
    pendingPredicate[id] = { id, value, deferred };
    pendingPredicateCount += 1;
    log.push(`predicate ${id} returned pending`);
    return deferred.promise;
  }

  let filtered;
  try {
    filtered = filterImplementation(source, predicate);
  } catch (error) {
    log.push(`filter threw ${observedValue(error)}`);
    filtered = null;
  }

  function callNext() {
    if (filtered === null) {
      return false;
    }

    const id = resultNextId;
    resultNextId += 1;
    log.push(`result.next call ${id}`);

    let result;
    try {
      result = filtered.next();
    } catch (error) {
      log.push(`result.next ${id} threw ${observedValue(error)}`);
      return true;
    }

    Promise.resolve(result).then(
      (iteration) => {
        if (iteration && iteration.done) {
          log.push(`result.next ${id} fulfilled done`);
        } else {
          log.push(`result.next ${id} fulfilled value ${iteration.value}`);
        }
      },
      (reason) => {
        log.push(`result.next ${id} rejected ${observedValue(reason)}`);
      },
    );
    return true;
  }

  function callReturn() {
    if (filtered === null || typeof filtered.return !== "function") {
      return false;
    }

    const id = resultReturnId;
    resultReturnId += 1;
    log.push(`result.return call ${id}`);

    let result;
    try {
      result = filtered.return();
    } catch (error) {
      log.push(`result.return ${id} threw ${observedValue(error)}`);
      return true;
    }

    Promise.resolve(result).then(
      (iteration) => {
        if (iteration && iteration.done) {
          log.push(`result.return ${id} fulfilled done`);
        } else {
          log.push(`result.return ${id} fulfilled value ${iteration.value}`);
        }
      },
      (reason) => {
        log.push(`result.return ${id} rejected ${observedValue(reason)}`);
      },
    );
    return true;
  }

  function applyEvent(event) {
    log.push(`event ${eventLabel(event)}`);

    if (event.type === "call next") {
      nextSourceOutcome = event.source ?? null;
      return callNext();
    }
    if (event.type === "call return") {
      return callReturn();
    }
    if (event.type === "settle source next value") {
      const pending = pendingSourceNext[event.id];
      if (pending === undefined) return false;
      pendingSourceNext[event.id] = undefined;
      pendingSourceNextCount -= 1;
      log.push(`source.next ${pending.id} fulfilled value ${event.value}`);
      predicateSyncPlan = event.predicate === "pending" ? null : event.predicate;
      if (event.predicate === "false") {
        nextSourceOutcome = event.source ?? null;
      }
      pending.deferred.resolve({ value: event.value, done: false });
      return true;
    }
    if (event.type === "settle source next done") {
      const pending = pendingSourceNext[event.id];
      if (pending === undefined) return false;
      pendingSourceNext[event.id] = undefined;
      pendingSourceNextCount -= 1;
      log.push(`source.next ${pending.id} fulfilled done`);
      pending.deferred.resolve({ value: undefined, done: true });
      return true;
    }
    if (event.type === "reject source next") {
      const pending = pendingSourceNext[event.id];
      if (pending === undefined) return false;
      pendingSourceNext[event.id] = undefined;
      pendingSourceNextCount -= 1;
      const reason = rejectedValue("source", pending.id);
      log.push(`source.next ${pending.id} rejected ${reason}`);
      pending.deferred.reject(reason);
      return true;
    }
    if (event.type === "settle predicate") {
      const pending = pendingPredicate[event.id];
      if (pending === undefined) return false;
      pendingPredicate[event.id] = undefined;
      pendingPredicateCount -= 1;
      log.push(`predicate ${pending.id} fulfilled ${event.accepted}`);
      if (!event.accepted) {
        nextSourceOutcome = event.source ?? null;
      }
      pending.deferred.resolve(event.accepted);
      return true;
    }
    if (event.type === "reject predicate") {
      const pending = pendingPredicate[event.id];
      if (pending === undefined) return false;
      pendingPredicate[event.id] = undefined;
      pendingPredicateCount -= 1;
      const reason = rejectedValue("predicate", pending.id);
      log.push(`predicate ${pending.id} rejected ${reason}`);
      pending.deferred.reject(reason);
      return true;
    }

    throw new Error(`unknown event: ${eventLabel(event)}`);
  }

  return {
    applyEvent,
    log,
    get pendingSourceNextCount() {
      return pendingSourceNextCount;
    },
    get pendingPredicateCount() {
      return pendingPredicateCount;
    },
  };
}

function expectedLogFromSequence(sequence) {
  const state = {
    log: [],
    nextSourceOutcome: null,
    nextSourceId: 0,
    nextPredicateId: 0,
    nextResultNextId: 0,
    nextResultReturnId: 0,
    nextSourceReturnId: 0,
    returned: false,
    pendingSourceReturn: false,
    stopped: false,
    doneSourceId: null,
    fatalReason: null,
    resultNexts: [],
    resultNextHead: 0,
    sourceItems: [],
    sourceById: [],
    predicateById: [],
    firstUnconsumedIndex: 0,
  };

  for (const event of sequence) {
    applyOracleEvent(state, event);
    drainOracle(state);
  }

  drainOracle(state);
  return state.log;
}

function applyOracleEvent(state, event) {
  state.log.push(`event ${eventLabel(event)}`);

  if (event.type === "call next") {
    const id = state.nextResultNextId;
    state.nextResultNextId += 1;
    state.log.push(`result.next call ${id}`);

    if (state.returned || state.stopped || state.fatalReason !== null) {
      state.log.push(`result.next ${id} fulfilled done`);
    } else {
      state.nextSourceOutcome = event.source ?? null;
      state.resultNexts.push({ id, settled: false });
    }
    return;
  }

  if (event.type === "call return") {
    const id = state.nextResultReturnId;
    state.nextResultReturnId += 1;
    state.log.push(`result.return call ${id}`);

    oracleReturnSource(state);

    state.log.push(`result.return ${id} fulfilled done`);
    return;
  }

  const item = event.type.includes("source next")
    ? state.sourceById[event.id]
    : state.predicateById[event.id];

  if (event.type === "settle source next value") {
    state.log.push(`source.next ${item.sourceId} fulfilled value ${event.value}`);
    if (oracleShouldIgnoreItem(state, item)) {
      item.state = "ignored";
    } else {
      item.value = event.value;
      if (event.predicate === "false") {
        state.nextSourceOutcome = event.source ?? null;
      }
      oracleCallPredicate(state, item, event.predicate);
    }
    return;
  }

  if (event.type === "settle source next done") {
    state.log.push(`source.next ${item.sourceId} fulfilled done`);
    if (oracleShouldIgnoreItem(state, item)) {
      item.state = "ignored";
    } else {
      item.state = "done";
      state.stopped = true;
      state.doneSourceId =
        state.doneSourceId === null ? item.sourceId : Math.min(state.doneSourceId, item.sourceId);
      oracleCapAtDone(state);
    }
    return;
  }

  if (event.type === "reject source next") {
    const reason = rejectedValue("source", item.sourceId);
    state.log.push(`source.next ${item.sourceId} rejected ${reason}`);
    if (oracleShouldIgnoreItem(state, item)) {
      item.state = "ignored";
    } else {
      item.state = "error";
      item.errorReason = reason;
      state.fatalReason = reason;
      state.returned = true;
    }
    return;
  }

  if (event.type === "settle predicate") {
    state.log.push(`predicate ${item.predicateId} fulfilled ${event.accepted}`);
    if (oracleShouldIgnoreItem(state, item)) {
      item.state = "ignored";
    } else {
      if (!event.accepted) {
        state.nextSourceOutcome = event.source ?? null;
      }
      item.state = event.accepted ? "accepted" : "rejected";
    }
    return;
  }

  if (event.type === "reject predicate") {
    const reason = rejectedValue("predicate", item.predicateId);
    state.log.push(`predicate ${item.predicateId} rejected ${reason}`);
    if (oracleShouldIgnoreItem(state, item)) {
      item.state = "ignored";
    } else {
      item.state = "error";
      item.errorReason = reason;
      state.fatalReason = reason;
      oracleReturnSource(state, { defer: true });
    }
    return;
  }

  throw new Error(`unknown oracle event: ${eventLabel(event)}`);
}

function drainOracle(state) {
  let changed = true;

  while (changed) {
    changed = false;

    if (
      !state.returned &&
      !state.stopped &&
      state.fatalReason === null &&
      oracleActiveSearchCount(state) < oracleResultNextCount(state)
    ) {
      markOracleReplacedRejected(state);
      oraclePullSource(state);
      changed = true;
    }

    while (oracleDrainResult(state)) {
      changed = true;
    }

    if (oracleFlushPendingSourceReturn(state)) {
      changed = true;
    }

    if (oracleDrainPostReturnFilteredResult(state)) {
      changed = true;
    }
  }
}

function oracleActiveSearchCount(state) {
  let count = 0;
  for (const item of state.sourceItems) {
    if (
      !item.consumed &&
      (item.state === "pending-source" ||
        item.state === "pending-predicate" ||
        item.state === "accepted" ||
        item.state === "error")
    ) {
      count += 1;
    }
  }
  return count;
}

function oraclePullSource(state) {
  const sourceId = state.nextSourceId;
  state.nextSourceId += 1;
  state.log.push(`source.next ${sourceId}`);

  const item = {
    sourceId,
    predicateId: undefined,
    state: "pending-source",
    value: undefined,
    consumed: false,
    errorReason: null,
    replaced: false,
  };
  state.sourceItems.push(item);
  state.sourceById[sourceId] = item;

  if (state.nextSourceOutcome === null) {
    state.log.push(`source.next ${sourceId} returned pending`);
    return;
  }

  const plan = state.nextSourceOutcome;
  state.nextSourceOutcome = null;

  if (plan.type === "pending") {
    state.log.push(`source.next ${sourceId} returned pending`);
  } else if (plan.type === "value") {
    state.log.push(`source.next ${sourceId} returned value ${plan.value}`);
    item.value = plan.value;
    oracleCallPredicate(state, item, plan.predicate);
  } else if (plan.type === "done") {
    state.log.push(`source.next ${sourceId} returned done`);
    item.state = "done";
    state.stopped = true;
    state.doneSourceId =
      state.doneSourceId === null ? item.sourceId : Math.min(state.doneSourceId, item.sourceId);
    oracleCapAtDone(state);
  } else if (plan.type === "throw") {
    const reason = thrownValue("source", sourceId);
    state.log.push(`source.next ${sourceId} threw ${reason}`);
    item.state = "error";
    item.errorReason = reason;
    state.fatalReason = reason;
    state.returned = true;
  }
}

function oracleCallPredicate(state, item, outcome) {
  const predicateId = state.nextPredicateId;
  state.nextPredicateId += 1;
  item.predicateId = predicateId;
  item.state = "pending-predicate";
  state.predicateById[predicateId] = item;
  state.log.push(`predicate ${predicateId} called with ${item.value}`);

  if (outcome === "pending") {
    state.log.push(`predicate ${predicateId} returned pending`);
    return;
  }

  if (outcome === "true") {
    state.log.push(`predicate ${predicateId} returned true`);
    item.state = "accepted";
  } else if (outcome === "false") {
    state.log.push(`predicate ${predicateId} returned false`);
    item.state = "rejected";
  } else if (outcome === "throw") {
    const reason = thrownValue("predicate", predicateId);
    state.log.push(`predicate ${predicateId} threw ${reason}`);
    item.state = "error";
    item.errorReason = reason;
    state.fatalReason = reason;
    oracleReturnSource(state, { defer: true });
  } else {
    throw new Error(`unknown predicate outcome: ${outcome}`);
  }
}

function oracleReturnSource(state, options = {}) {
  if (state.returned || state.stopped) {
    return;
  }

  if (options.defer) {
    state.returned = true;
    state.pendingSourceReturn = true;
    return;
  }

  state.returned = true;
  const sourceReturnId = state.nextSourceReturnId;
  state.nextSourceReturnId += 1;
  state.log.push(`source.return ${sourceReturnId}`);
}

function oracleFlushPendingSourceReturn(state) {
  if (!state.pendingSourceReturn) {
    return false;
  }

  state.pendingSourceReturn = false;
  const sourceReturnId = state.nextSourceReturnId;
  state.nextSourceReturnId += 1;
  state.log.push(`source.return ${sourceReturnId}`);
  return true;
}

function oracleDrainResult(state) {
  let firstUnconsumed = firstOracleUnconsumed(state);

  while (firstUnconsumed && oracleResultNextCount(state) > 0) {
    if (firstUnconsumed.state === "ignored" || firstUnconsumed.state === "rejected") {
      firstUnconsumed.consumed = true;
      state.firstUnconsumedIndex += 1;
      if (
        (state.returned || state.stopped) &&
        !firstUnconsumed.replaced &&
        !oracleNextRetainedOutcomeIsExposed(state)
      ) {
        const request = popOracleResultNext(state);
        state.log.push(`result.next ${request.id} fulfilled done`);
        return true;
      }
      firstUnconsumed = firstOracleUnconsumed(state);
      continue;
    }

    if (firstUnconsumed.state === "accepted") {
      firstUnconsumed.consumed = true;
      state.firstUnconsumedIndex += 1;
      const request = shiftOracleResultNext(state);
      state.log.push(`result.next ${request.id} fulfilled value ${firstUnconsumed.value}`);
      if (
        (state.returned || state.stopped) &&
        !oracleNextRetainedOutcomeIsExposed(state) &&
        oracleResultNextCount(state) > oracleFutureActiveSearchCount(state)
      ) {
        oracleSettleDoneFromOffset(state, oracleFutureActiveSearchCount(state));
      }
      return true;
    }

    if (firstUnconsumed.state === "done") {
      state.stopped = true;
      firstUnconsumed.consumed = true;
      state.firstUnconsumedIndex += 1;
      return oracleSettleDoneFromOffset(state, 0);
    }

    if (firstUnconsumed.state === "error") {
      firstUnconsumed.consumed = true;
      state.firstUnconsumedIndex += 1;
      oracleFlushPendingSourceReturn(state);
      const request = shiftOracleResultNext(state);
      state.log.push(`result.next ${request.id} rejected ${firstUnconsumed.errorReason}`);
      if (
        !oracleNextRetainedOutcomeIsExposed(state) &&
        oracleResultNextCount(state) > oracleFutureActiveSearchCount(state)
      ) {
        oracleSettleDoneFromOffset(state, oracleFutureActiveSearchCount(state));
      }
      return true;
    }

    const done = firstOracleDone(state);
    if (done) {
      const offset = oracleOpenResultSlotsBefore(state, done);
      done.consumed = true;
      return oracleSettleDoneFromOffset(state, offset);
    }

    return false;
  }

  return false;
}

function oracleDrainPostReturnFilteredResult(state) {
  if ((!state.returned && !state.stopped) || oracleResultNextCount(state) === 0) {
    return false;
  }

  for (const item of state.sourceItems) {
    if (!item.consumed && item.state === "rejected" && !item.replaced) {
      if (oracleWouldExposeRetainedOutcome(state, item)) {
        return false;
      }
      item.consumed = true;
      const request = popOracleResultNext(state);
      state.log.push(`result.next ${request.id} fulfilled done`);
      return true;
    }
  }

  return false;
}

function oracleWouldExposeRetainedOutcome(state, item) {
  if (item.consumed || item.state !== "rejected") {
    return false;
  }

  for (let index = state.firstUnconsumedIndex; index < state.sourceItems.length; index += 1) {
    const candidate = state.sourceItems[index] === item ? { ...item, consumed: true } : state.sourceItems[index];
    if (
      candidate.consumed ||
      candidate.state === "ignored" ||
      candidate.state === "rejected"
    ) {
      continue;
    }
    return candidate.state === "accepted" || candidate.state === "error";
  }
  return false;
}

function markOracleReplacedRejected(state) {
  for (const item of state.sourceItems) {
    if (!item.consumed && item.state === "rejected" && !item.replaced) {
      item.replaced = true;
      return;
    }
  }
}

function oracleHasEarlierUnresolvedItem(state, target) {
  for (const item of state.sourceItems) {
    if (item === target) {
      return false;
    }
    if (
      !item.consumed &&
      item.sourceId < target.sourceId &&
      (item.state === "pending-source" ||
        item.state === "pending-predicate" ||
        item.state === "accepted" ||
        item.state === "rejected" ||
        item.state === "error")
    ) {
      return true;
    }
  }
  return false;
}

function oracleHasEarlierUnresolvedErrorBefore(state, target) {
  const error = firstOracleError(state);
  return (
    error !== undefined &&
    error.sourceId < target.sourceId &&
    oracleHasEarlierUnresolvedItem(state, error)
  );
}

function firstOracleError(state) {
  for (const item of state.sourceItems) {
    if (!item.consumed && item.state === "error") {
      return item;
    }
  }
  return undefined;
}

function oracleNextRetainedOutcomeIsExposed(state) {
  for (let index = state.firstUnconsumedIndex; index < state.sourceItems.length; index += 1) {
    const item = state.sourceItems[index];
    if (item.consumed || item.state === "ignored" || item.state === "rejected") {
      continue;
    }
    return item.state === "accepted" || item.state === "error";
  }
  return false;
}

function oracleFutureActiveSearchCount(state) {
  let count = 0;
  for (const item of state.sourceItems) {
    if (
      !item.consumed &&
      (item.state === "pending-source" ||
        item.state === "pending-predicate" ||
        item.state === "accepted" ||
        item.state === "error")
    ) {
      count += 1;
    }
  }
  return count;
}

function oracleResultNextCount(state) {
  let count = 0;
  for (let index = state.resultNextHead; index < state.resultNexts.length; index += 1) {
    if (!state.resultNexts[index].settled) {
      count += 1;
    }
  }
  return count;
}

function shiftOracleResultNext(state) {
  const index = firstPendingOracleResultIndex(state);
  const request = state.resultNexts[index];
  request.settled = true;
  advanceOracleResultHead(state);
  return request;
}

function popOracleResultNext(state) {
  for (let index = state.resultNexts.length - 1; index >= state.resultNextHead; index -= 1) {
    const request = state.resultNexts[index];
    if (!request.settled) {
      request.settled = true;
      advanceOracleResultHead(state);
      return request;
    }
  }
  throw new Error("no pending result next");
}

function oracleSettleDoneFromOffset(state, offset) {
  let pendingIndex = firstPendingOracleResultIndex(state);
  for (let skipped = 0; skipped < offset && pendingIndex < state.resultNexts.length; skipped += 1) {
    pendingIndex += 1;
    while (pendingIndex < state.resultNexts.length && state.resultNexts[pendingIndex].settled) {
      pendingIndex += 1;
    }
  }

  let changed = false;
  for (let index = pendingIndex; index < state.resultNexts.length; index += 1) {
    const request = state.resultNexts[index];
    if (!request.settled) {
      request.settled = true;
      state.log.push(`result.next ${request.id} fulfilled done`);
      changed = true;
    }
  }
  advanceOracleResultHead(state);
  return changed;
}

function firstPendingOracleResultIndex(state) {
  advanceOracleResultHead(state);
  return state.resultNextHead;
}

function advanceOracleResultHead(state) {
  while (
    state.resultNextHead < state.resultNexts.length &&
    state.resultNexts[state.resultNextHead].settled
  ) {
    state.resultNextHead += 1;
  }
}

function oracleShouldIgnoreItem(state, item) {
  return state.doneSourceId !== null && item.sourceId > state.doneSourceId;
}

function oracleCapAtDone(state) {
  if (state.doneSourceId === null) {
    return;
  }
  for (const item of state.sourceItems) {
    if (!item.consumed && item.state !== "ignored" && item.sourceId > state.doneSourceId) {
      item.state = "ignored";
    }
  }
}

function firstOracleDone(state) {
  for (const item of state.sourceItems) {
    if (!item.consumed && item.state === "done") {
      return item;
    }
  }
  return undefined;
}

function oracleOpenResultSlotsBefore(state, target) {
  let count = 0;
  for (const item of state.sourceItems) {
    if (item === target) {
      return count;
    }
    if (
      !item.consumed &&
      item.state !== "ignored" &&
      item.state !== "rejected" &&
      item.sourceId < target.sourceId
    ) {
      count += 1;
    }
  }
  return count;
}

function firstOracleUnconsumed(state) {
  while (
    state.firstUnconsumedIndex < state.sourceItems.length &&
    state.sourceItems[state.firstUnconsumedIndex].consumed
  ) {
    state.firstUnconsumedIndex += 1;
  }

  return state.sourceItems[state.firstUnconsumedIndex];
}

async function runScenario(filterImplementation, sequence) {
  const harness = createHarness(filterImplementation);

  for (const event of sequence) {
    const coherent = harness.applyEvent(event);
    if (!coherent) {
      return null;
    }
    await flushMicrotasks();
  }

  await flushMicrotasks();
  return harness.log;
}

async function testSequence(sequence) {
  const expected = expectedLogFromSequence(sequence);
  const actual = await runScenario(filter, sequence);
  assertArrayEqual(actual, expected, `sequence ${sequenceLabel(sequence)}`);
  return true;
}

function formatLog(label, log) {
  if (log === null) {
    return `${label}: <incoherent / null>`;
  }
  const lines = log.map((entry, index) => `  ${index}: ${entry}`);
  return `${label} (${log.length} lines):\n${lines.join("\n")}`;
}

async function testSequenceOrStop(sequence) {
  try {
    return await testSequence(sequence);
  } catch (error) {
    console.error(`first failing sequence: ${sequenceLabel(sequence)}`);
    const expected = expectedLogFromSequence(sequence);
    const actual = await runScenario(filter, sequence);
    console.error(formatLog("EXPECTED", expected));
    console.error(formatLog("ACTUAL", actual));
    throw error;
  }
}

async function testHappyPathOrder() {
  const sequence = [
    { type: "call next", id: 0 },
    { type: "call next", id: 1 },
    { type: "settle source next value", id: 1, value: "v0", predicate: "pending" },
    { type: "settle source next value", id: 0, value: "v1", predicate: "pending" },
    { type: "settle predicate", id: 1, accepted: true },
    { type: "settle predicate", id: 0, accepted: true },
  ];
  const expected = [
    "event call next 0",
    "result.next call 0",
    "source.next 0",
    "source.next 0 returned pending",
    "event call next 1",
    "result.next call 1",
    "source.next 1",
    "source.next 1 returned pending",
    "event settle source next value 1 v0 predicate pending",
    "source.next 1 fulfilled value v0",
    "predicate 0 called with v0",
    "predicate 0 returned pending",
    "event settle source next value 0 v1 predicate pending",
    "source.next 0 fulfilled value v1",
    "predicate 1 called with v1",
    "predicate 1 returned pending",
    "event settle predicate 1 true",
    "predicate 1 fulfilled true",
    "result.next 0 fulfilled value v1",
    "event settle predicate 0 true",
    "predicate 0 fulfilled true",
    "result.next 1 fulfilled value v0",
  ];

  assertArrayEqual(
    expectedLogFromSequence(sequence),
    expected,
    "oracle happy path out-of-order source settlement",
  );
}

async function main() {
  let coherentCount = 0;
  let totalCount = 0;

  await testHappyPathOrder();

  for (const sequence of eventSequences(MAX_EVENT_COUNT)) {
    totalCount += 1;
    if (await testSequenceOrStop(sequence)) {
      coherentCount += 1;
    }
  }

  console.log(
    `filter exhaustive test passed: ${coherentCount}/${totalCount} coherent sequences up to ${MAX_EVENT_COUNT} events`,
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  throw error;
});

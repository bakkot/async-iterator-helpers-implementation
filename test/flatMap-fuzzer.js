// Invariant-based differential test for the concurrent `flatMap`.
//
// Usage:
//   node test/flatMap-fuzzer.js [N]                 exhaustive over schedules <= N events
//   node test/flatMap-fuzzer.js [N] --fuzz COUNT [--seed S]   random schedules
//   node test/flatMap-fuzzer.js [N] --replay '[..]'          replay one decision vector
//
// Exhaustive enumeration is only practical for a quick smoke test (N=2 is a few
// thousand schedules; it blows up fast with N because of flatMap's nested
// pull/mapper/inner fan-out). Real coverage comes from --fuzz at larger N, which
// can reach any schedule the enumeration would (every choice has positive
// probability). A failing fuzz case prints a --replay vector for instant repro.
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
// A .return() can resolve, throw synchronously, or return a pending promise that
// later resolves or rejects. (An iterator may also have NO .return() at all; that
// is decided per-iterator at creation, see hasReturn.)
const RETURN_SHAPES = ['sync', 'syncThrow', 'pending'];
const RETURN_OUTCOMES = ['resolve', 'reject']; // for a pending .return()
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
// Errors produced by a .return() (a close failure) live in a separate namespace
// from stream errors above: a close failure must never surface as a stream error.
const underlyingReturnError = 'EretU';
const innerReturnError = (k) => `EretI${k}`;

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
    returnErrors: new Set(), // close-error tags a .return() actually produced
  };

  // Whether the helper has terminated, derived from OBSERVABLE facts rather than
  // guessed from stub responses: the consumer returned, or the underlying was
  // seen done/error, or flatMap closed the underlying (which it does exactly when
  // terminating on a mapper/inner error or a consumer return). Crucially this does
  // NOT treat a stub's sync-throw as termination -- flatMap may truncate/discard
  // that pull (e.g. an inner done arrived first), in which case the helper lives
  // on. An inner *done* never ends the stream, so it is not part of this either.
  let consumerReturned = false;
  // A terminal stream error -- an inner pull that errored, or a mapper that
  // errored -- ends the helper just as much as a consumer return() or an
  // underlying done/error. We track these causes DIRECTLY rather than inferring
  // termination from `rec.underlying.returnCalls > 0` (flatMap closing the
  // underlying): that proxy silently misses the case where the underlying has no
  // .return() method, so flatMap's `return?.()` is a no-op and no close is
  // recorded even though the helper has genuinely terminated. (An inner *done*
  // still never ends the stream, so it is deliberately not included here.)
  //
  // BUT an inner-pull error only terminates the helper if flatMap actually
  // OBSERVES it: a done from the SAME inner at a LOWER pull index that settled
  // EARLIER truncates the later in-flight pulls, so their outcomes are post-end
  // noise that flatMap discards -- the helper lives on. Both orders matter (a
  // done at a HIGHER index does not truncate earlier pulls, and a done settling
  // AFTER the error arrives too late), so we compare pull index and settlement
  // order (`seq`, a global counter recording when each outcome became known).
  const innerErrorObserved = (inner, p) =>
    !inner.pulls.some((q) => q.status === 'done' && q.idx < p.idx && q.seq < p.seq);
  const streamErrored = () =>
    rec.inners.some((inner) => inner.pulls.some((p) => p.status === 'error' && innerErrorObserved(inner, p))) ||
    rec.mappers.some((m) => m.outcome === 'error');
  const isFinished = () => consumerReturned || rec.underlying.finished != null || rec.underlying.returnCalls > 0 || streamErrored();

  let eventSeq = 0;
  const log = (line) => { rec.events.push(line); eventSeq++; };
  // Settlement order: bumped each time a pull's outcome becomes known (a sync
  // response, or the chooser settling a pending one). Within one synchronous
  // burst flatMap's .then callbacks run in issue order, and each settle action
  // is flushed to quiescence before the next, so this matches the order flatMap
  // observes the outcomes.
  let settleSeq = 0;
  const violation = (msg) => { rec.violations.push(msg); log(`!! VIOLATION: ${msg}`); };

  // Outstanding (unsettled) consumer next() calls -- the live demand.
  const outstandingNext = () => rec.calls.reduce((a, c) => a + (c.kind === 'next' && c.settle === null ? 1 : 0), 0);
  // (Laziness) flatMap pulls only to satisfy demand: issuing a pull while no
  // next() call is outstanding would be speculative/eager buffering. Checked at
  // ISSUE time (a pull is always created for currently-live demand), which avoids
  // counting truncation-orphaned pulls. Not checked during finalize (the wind-down
  // legitimately drives iterators with no remaining consumer).
  const checkLazyPull = (what) => {
    if (!finalizing && outstandingNext() === 0) violation(`speculative pull: ${what} issued with no outstanding next() call`);
  };

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

  // Checked after each driving action's flush-to-quiescence:
  // (I10) liveness at quiescence: if every promise the stubs ever handed out has
  // settled (no pending pulls, no pending mapper, no pending returns) and the
  // microtask queue has drained, every consumer call must have settled. An
  // unsettled call at such a point can never settle on its own -- nothing remains
  // that could wake the helper -- even if a later consumer call would mask the
  // hang by re-driving the machinery (which is why the end-of-run hang check I9
  // alone is not enough).
  // (I11) close-gating, a partial converse: while a .return() that flatMap issued
  // is still pending, some consumer promise must be unsettled -- result.return()
  // awaits the closes it triggers, and an error that triggers a close surfaces
  // only after that close settles, so a pending close with every consumer call
  // settled means flatMap fired a close nothing can ever observe.
  //
  // DELIBERATE WEAKENING: there is one legitimate "orphaned close" -- an error
  // triggers a close, and before that close settles an inner done at a lower
  // pull index truncates the still-undelivered error; the calls then resolve
  // done immediately and the close's outcome is swallowed (pinned by unit test
  // flatmap-test-062). We exempt any run containing such a discarded
  // (produced-but-never-delivered) error, which also exempts any OTHER pending
  // close in that run -- a real loss of strength, accepted for now. If the
  // implementation ever gates those dones on the close instead, remove the
  // exemption (and flip the unit test).
  const reportedSettlementViolations = new Set();
  const reportSettlementViolation = (msg) => {
    if (reportedSettlementViolations.has(msg)) return;
    reportedSettlementViolations.add(msg);
    violation(msg);
  };
  const checkSettlementInvariants = () => {
    const unsettled = rec.calls.filter((c) => c.settle === null);
    if (pendingPulls.length === 0 && pendingMapper === null && pendingReturns.length === 0) {
      for (const c of unsettled) reportSettlementViolation(`liveness: ${c.kind}#${c.id} is unsettled at quiescence with nothing pending`);
    }
    if (pendingReturns.length > 0 && unsettled.length === 0) {
      // Every call has settled, so any error that has not been delivered by now
      // never will be: it was discarded, and may have orphaned a close.
      const delivered = new Set(rec.calls.filter((c) => c.settle.type === 'reject').map((c) => c.settle.error));
      const discardedErrorExists = [...realErrors(rec)].some((e) => !delivered.has(e));
      if (!discardedErrorExists) {
        reportSettlementViolation(`close-gating: ${pendingReturns.map((r) => r.id).join(', ')} pending but every consumer call has settled`);
      }
    }
  };

  // A .return() method shared by the underlying and inner iterators. `entity` is
  // the record (rec.underlying or an inner) carrying its bookkeeping; `errTag` is
  // the close-error this iterator's return uses. The "return after this iterator
  // finished on its own" check is at CALL TIME (not step-gated): flatMap must never
  // close an iterator it has already seen finish, and a close issued in the same
  // tick as observing the finish is still a bug. (This cannot false-positive on
  // "return() then an in-flight pull settles done later", because that later finish
  // is recorded after this check has already run.)
  const makeReturn = (entity, label, errTag) => function () {
    const n = entity.returnCalls;
    log(`${label}.return#${n}`);
    if (entity.finished != null) violation(`${label}.return() after ${label} ${entity.finished}`);
    if (n > 0) violation(`${label}.return() called more than once`);
    entity.returnCalls++;
    entity.returnStep = stepNo;
    const shape = finalizing ? 'sync' : RETURN_SHAPES[chooser.choose(RETURN_SHAPES.length)];
    if (shape === 'sync') return { value: undefined, done: true };
    if (shape === 'syncThrow') { rec.returnErrors.add(errTag); throw new Error(errTag); }
    const d = Promise.withResolvers();
    pendingReturns.push({ id: `${label}ret#${n}`, errTag, d });
    return d.promise;
  };

  // --- the underlying source ------------------------------------------------

  // Each iterator independently may or may not even have a .return() method; the
  // implementation must cope with its absence (it uses `?.()`), and we must not
  // count a never-pulled / abandoned no-return iterator as a leak.
  const underlyingHasReturn = chooser.choose(2) === 0;
  rec.underlying.hasReturn = underlyingHasReturn;

  const source = {
    next() {
      const idx = rec.underlying.pulls.length;
      log(`U.next#${idx}`);
      checkLazyPull(`U.next#${idx}`);
      if (rec.underlying.finishedStep != null && stepNo > rec.underlying.finishedStep) violation(`U.next#${idx} after underlying ${rec.underlying.finished}`);
      if (rec.underlying.returnStep != null && stepNo > rec.underlying.returnStep) violation(`U.next#${idx} after U.return()`);
      if (pendingPulls.some((p) => p.kind === 'U')) violation(`a second concurrent underlying pull at #${idx}`);
      const pull = { idx, status: 'pending' };
      rec.underlying.pulls.push(pull);
      const shape = (finalizing || idx >= maxPulls) ? 'syncDone' : PULL_SHAPES[chooser.choose(PULL_SHAPES.length)];
      if (shape === 'syncValue') { pull.status = 'value'; pull.value = underlyingValue(idx); return { value: pull.value, done: false }; }
      if (shape === 'syncDone') { pull.status = 'done'; rec.underlying.finished = 'done'; rec.underlying.finishedStep = stepNo; return { value: undefined, done: true }; }
      if (shape === 'syncThrow') { pull.status = 'error'; rec.underlying.finished = 'error'; rec.underlying.finishedStep = stepNo; throw new Error(underlyingError(idx)); }
      const d = Promise.withResolvers();
      pendingPulls.push({ id: `U#${idx}`, kind: 'U', idx, d });
      return d.promise;
    },
    [Symbol.asyncIterator]() { return this; },
  };
  if (underlyingHasReturn) source.return = makeReturn(rec.underlying, 'U', underlyingReturnError);

  // --- inner iterators (one per successful mapper call) ----------------------

  const createInner = () => {
    const id = rec.inners.length;
    // No chooser during finalize (it must stay deterministic), so wind-down inners
    // always have a return.
    const hasReturn = finalizing ? true : chooser.choose(2) === 0;
    const inner = { id, pulls: [], returnCalls: 0, finished: null, finishedStep: null, returnStep: null, hasReturn, createdWhileFinished: isFinished() };
    rec.inners.push(inner);
    inner.iterator = {
      next() {
        const idx = inner.pulls.length;
        log(`I${id}.next#${idx}`);
        checkLazyPull(`I${id}.next#${idx}`);
        if (inner.finishedStep != null && stepNo > inner.finishedStep) violation(`I${id}.next#${idx} after inner ${inner.finished}`);
        if (inner.returnStep != null && stepNo > inner.returnStep) violation(`I${id}.next#${idx} after I${id}.return()`);
        const pull = { idx, status: 'pending' };
        inner.pulls.push(pull);
        const shape = (finalizing || idx >= maxPulls) ? 'syncDone' : PULL_SHAPES[chooser.choose(PULL_SHAPES.length)];
        if (shape === 'syncValue') { pull.status = 'value'; pull.seq = settleSeq++; pull.value = innerValue(id, idx); return { value: pull.value, done: false }; }
        if (shape === 'syncDone') { pull.status = 'done'; pull.seq = settleSeq++; inner.finished = 'done'; inner.finishedStep = stepNo; return { value: undefined, done: true }; }
        if (shape === 'syncThrow') { pull.status = 'error'; pull.seq = settleSeq++; inner.finished = 'error'; inner.finishedStep = stepNo; throw new Error(innerError(id, idx)); }
        const d = Promise.withResolvers();
        pendingPulls.push({ id: `I${id}#${idx}`, kind: 'I', innerId: id, idx, d });
        return d.promise;
      },
      [Symbol.asyncIterator]() { return this; },
    };
    if (hasReturn) inner.iterator.return = makeReturn(inner, `I${id}`, innerReturnError(id));
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
    if (shape === 'syncThrow') { m.outcome = 'error'; throw new Error(mapperError(id)); }
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
    consumerReturned = true;
    try { trackCall(call, Promise.resolve(fm.return())); }
    catch (e) { call.settle = { type: 'reject', error: e && e.message }; log(`return#${call.id} threw ${e && e.message}`); }
  };

  // --- settling a chosen pending obligation ---------------------------------

  const settlePull = (entry, outcome) => {
    pendingPulls.splice(pendingPulls.indexOf(entry), 1);
    const pull = entry.kind === 'U' ? rec.underlying.pulls[entry.idx] : rec.inners[entry.innerId].pulls[entry.idx];
    pull.seq = settleSeq++;
    if (outcome === 'value') {
      pull.status = 'value';
      pull.value = entry.kind === 'U' ? underlyingValue(entry.idx) : innerValue(entry.innerId, entry.idx);
      entry.d.resolve({ value: pull.value, done: false });
    } else if (outcome === 'done') {
      pull.status = 'done';
      if (entry.kind === 'U') { rec.underlying.finished = 'done'; rec.underlying.finishedStep = stepNo; }
      else { rec.inners[entry.innerId].finished = 'done'; rec.inners[entry.innerId].finishedStep = stepNo; }
      entry.d.resolve({ value: undefined, done: true });
    } else {
      pull.status = 'error';
      if (entry.kind === 'U') { rec.underlying.finished = 'error'; rec.underlying.finishedStep = stepNo; entry.d.reject(new Error(underlyingError(entry.idx))); }
      else { rec.inners[entry.innerId].finished = 'error'; rec.inners[entry.innerId].finishedStep = stepNo; entry.d.reject(new Error(innerError(entry.innerId, entry.idx))); }
    }
  };
  const settleMapper = (outcome) => {
    const m = rec.mappers[pendingMapper.id];
    const d = pendingMapper.d;
    pendingMapper = null;
    if (outcome === 'iter') { m.outcome = 'iter'; const inner = createInner(); m.innerId = inner.id; d.resolve(inner.iterator); }
    else { m.outcome = 'error'; d.reject(new Error(mapperError(m.id))); }
  };
  const settleReturn = (entry, outcome = 'resolve') => {
    pendingReturns.splice(pendingReturns.indexOf(entry), 1);
    if (outcome === 'reject') { rec.returnErrors.add(entry.errTag); entry.d.reject(new Error(entry.errTag)); }
    else entry.d.resolve({ value: undefined, done: true });
  };

  // --- legal action set at the current state --------------------------------

  const actions = [];
  const computeLegal = () => {
    if (actions.length >= maxEvents) return [{ t: 'stop' }];
    const legal = [{ t: 'next' }, { t: 'return' }];
    for (const p of pendingPulls) for (const o of PULL_OUTCOMES) legal.push({ t: 'settlePull', entry: p, o });
    if (pendingMapper) for (const o of MAPPER_OUTCOMES) legal.push({ t: 'settleMapper', o });
    for (const r of pendingReturns) for (const o of RETURN_OUTCOMES) legal.push({ t: 'settleReturn', entry: r, o });
    if (!pendingPulls.length && !pendingMapper && !pendingReturns.length) legal.push({ t: 'stop' });
    return legal;
  };
  const actionLabel = (a) => {
    switch (a.t) {
      case 'next': return 'next()';
      case 'return': return 'return()';
      case 'settlePull': return `settle ${a.entry.id}:${a.o}`;
      case 'settleMapper': return `settleMapper:${a.o}`;
      case 'settleReturn': return `settle ${a.entry.id}:${a.o}`;
      case 'stop': return 'stop';
    }
  };

  const apply = (a) => {
    if (a.t === 'next') doNext();
    else if (a.t === 'return') doReturn();
    else if (a.t === 'settlePull') settlePull(a.entry, a.o);
    else if (a.t === 'settleMapper') settleMapper(a.o);
    else if (a.t === 'settleReturn') settleReturn(a.entry, a.o);
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
    checkSettlementInvariants();
  }

  // Snapshot the natural end-of-schedule state BEFORE finalization perturbs it.
  // The cleanup/leak invariant reasons about what was open when the helper
  // terminated; finalization (which force-settles leftovers) would otherwise
  // rewrite "open" iterators into "finished" ones.
  rec.finishedNaturally = isFinished();
  rec.underlying.naturalFinished = rec.underlying.finished;
  // Whether the helper was mid-read (an underlying pull or the mapper in flight)
  // when the schedule stopped. Closes are deferred until that read settles, so in
  // this state the underlying's close (or the discovery that it finished itself
  // and needs no close) legitimately happens during finalization; the leak check
  // then judges the underlying by its final state instead of this snapshot.
  rec.underlying.midReadAtEnd = pendingPulls.some((p) => p.kind === 'U') || pendingMapper != null;
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

  // (I8) return() resolves {done:true}, OR rejects with a real close error (a
  // .return() that threw/rejected). It never resolves a value, and never rejects
  // with a fabricated or stream error.
  for (const c of retCalls) {
    if (!c.settle || c.settle.type === 'done') continue;
    if (c.settle.type === 'reject') {
      if (!rec.returnErrors.has(c.settle.error)) add(`return#${c.id} rejected with ${c.settle.error}, which no .return() produced`);
    } else {
      add(`return#${c.id} settled as ${fmtSettle(c.settle)} (expected {done:true} or a close rejection)`);
    }
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

  // (I5) {done:true} is terminal in CALL order for the STREAM: once a next() call
  // resolves done, no later next() (by call id) may resolve with a value or error.
  // A done may settle earlier in TIME than an in-flight value (e.g. a value
  // requested before a done that lands after it), but only when the done is later
  // in call order. Equivalently: among next() calls, dones form a suffix.
  // (return() outcomes are excluded -- they are close results, not stream items,
  // and are validated separately by I8.)
  let sawDone = false;
  for (const c of nextCalls) {
    if (!c.settle) continue;
    if (c.settle.type === 'done') sawDone = true;
    else if (sawDone) add(`next#${c.id} delivered ${fmtSettle(c.settle)} after an earlier-in-call-order {done:true}`);
  }

  // (I1/I3) The inner ITEMS delivered (a pull's value, or that pull's own error --
  // an already-issued inner pull surfaces its own result either way) must, in call
  // order, be strictly increasing in (innerIterCreationOrder, pullIndex), and each
  // value must be one genuinely produced. Underlying/mapper errors are terminal
  // stream errors with no inner coordinate; they are covered by I4/I5, not here.
  const produced = producedValues(rec);
  const deliveredByIter = new Map(); // k -> [j, ...] in delivery order
  let prevK = -1, prevJ = -1;
  for (const c of nextCalls) {
    if (!c.settle) continue;
    let k, j;
    if (c.settle.type === 'value') {
      const v = c.settle.value;
      const m = /^(\d+):(\d+)$/.exec(v);
      if (!m) { add(`next#${c.id} delivered a non-inner value ${v}`); continue; }
      if (!produced.has(v)) { add(`next#${c.id} delivered ${v}, which no inner pull produced`); continue; }
      k = Number(m[1]); j = Number(m[2]);
    } else if (c.settle.type === 'reject') {
      const m = /^Ei(\d+)\.(\d+)$/.exec(c.settle.error);
      if (!m) continue; // underlying/mapper error: not an inner item
      k = Number(m[1]); j = Number(m[2]);
    } else continue; // done
    if (k < prevK || (k === prevK && j <= prevJ)) {
      add(`out-of-order/duplicate inner delivery: next#${c.id} got (${k}:${j}) after (${prevK}:${prevJ})`);
    }
    prevK = k; prevJ = j;
    if (!deliveredByIter.has(k)) deliveredByIter.set(k, []);
    deliveredByIter.get(k).push(j);
  }

  // (I1, contiguity) Within one inner iterator, delivered item indices must be a
  // gap-free prefix 0,1,2,...: an inner's pulls are delivered in order and none is
  // skipped. (Strict increase alone would miss a dropped middle item like
  // delivering 0:0 then 0:2.)
  for (const [k, js] of deliveredByIter) {
    for (let t = 0; t < js.length; t++) {
      if (js[t] !== t) { add(`inner I${k} delivered non-contiguous item indices [${js.join(',')}] (expected 0..${js.length - 1})`); break; }
    }
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
    // The underlying must be closed once the helper terminates unless it finished
    // on its own -- including a return() before the first pull (map/filter close
    // it unconditionally), so this is NOT exempted for the never-pulled case. An
    // iterator without a .return() method has nothing to close, so it can't leak.
    //
    // When the helper terminated while mid-read (underlying pull or mapper in
    // flight), the close is DEFERRED until that read settles, which happens during
    // finalization: judge by the final state (returnCalls is cumulative, so a
    // finalize-time close counts; a pull force-settled done means the underlying
    // finished itself and correctly needs no close). The cost of this relaxation:
    // a path that abandons an in-flight pull where it should instead close on its
    // settlement would be masked here, since finalize's forced done looks like a
    // natural finish.
    const underlyingFinishedForLeak = rec.underlying.midReadAtEnd ? rec.underlying.finished : rec.underlying.naturalFinished;
    if (!underlyingFinishedForLeak && rec.underlying.returnCalls === 0 && rec.underlying.hasReturn) {
      add(`underlying was left open at termination (not finished, not .return()'d): leak`);
    }
    for (const inner of rec.inners) {
      if (inner.pulls.length === 0) {
        // A live inner is always pulled immediately on creation, so a zero-pull
        // inner can only be one the mapper produced AFTER the helper had already
        // finished via another path (so flatMap never adopts it). flatMap arguably
        // ought to close it, but that's a separate corner; don't count it as a leak.
        if (!inner.createdWhileFinished) add(`inner I${inner.id} was created but never pulled`);
        continue;
      }
      // Inners created DURING finalize never existed at natural termination, so the
      // pre-finalize snapshot says nothing about them: use their actual finished
      // status (anything pulled during finalize is force-settled done, so it really
      // did finish). For inners that existed at natural termination, keep using the
      // snapshot so finalize's force-settling can't mask a genuine open-at-end leak.
      const finishedForLeak = inner.naturalFinished !== undefined ? inner.naturalFinished : inner.finished;
      if (!finishedForLeak && inner.returnCalls === 0 && inner.hasReturn) {
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
  const maxEvents = Number(positionals[0] ?? (values.fuzz !== undefined ? 5 : 1));
  setFlushChunk(Math.max(16, 3 * maxEvents));
  if (values.replay !== undefined) return runReplay(maxEvents, JSON.parse(values.replay));
  if (values.fuzz !== undefined) return runFuzz(maxEvents, Number(values.fuzz), values.seed);
  return runExhaustive(maxEvents);
}

main();

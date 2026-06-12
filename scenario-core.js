// Shared machinery for the scenario format (see FORMAT.md): event
// classification, handle/index resolution, validation, and rendering of
// expected log lines. Used by both scenario-to-test.js and
// scenario-to-animation.js. Dependency-free and browser-safe.

export const DEFAULT_NAMES = {
  map: { source: 'src', fn: 'fn', fnDisplay: 'f' },
  filter: { source: 'src', fn: 'pred', fnDisplay: 'pred' },
  flatMap: { source: 'src', fn: 'm', fnDisplay: 'f' },
};

export function scenarioNames(scenario) {
  return { ...DEFAULT_NAMES[scenario.helper], ...(scenario.names ?? {}) };
}

const STIMULI = new Set(['next', 'return', 'settle', 'fn-settle', 'arm-throw', 'close-settled']);
const OBSERVATIONS = new Set(['pull', 'inner-pull', 'fn', 'close', 'result']);
const ANNOTATIONS = new Set(['open-closing', 'tombstone', 'compact', 'void', 'slot-error']);
const DEFINITIONS = new Set(['fn-sync']);

// Walk the whole scenario once, resolving every handle to its derived
// numbering (log indices, diagram rows) and classifying every event. Throws
// with all validation errors at once. The result is consumed by both
// executors.
export function indexScenario(scenario) {
  const errors = [];
  const fail = (where, msg) => errors.push(`${where}: ${msg}`);

  if (!['map', 'filter', 'flatMap'].includes(scenario.helper)) {
    throw new Error(`scenario ${scenario.id}: unknown helper ${JSON.stringify(scenario.helper)}`);
  }
  const names = scenarioNames(scenario);

  const pulls = new Map();   // handle -> { kind: 'source'|'inner', iterator, index, row, col, settled }
  const calls = new Map();   // handle -> { index, slot, arg, settled }
  const results = new Map(); // handle -> { kind: 'next'|'return', row, settled }
  const inners = new Map();  // handle -> { slot, pullCount, nextIndex }
  const fnSync = [];         // fn-sync definitions
  let usesFnSettle = false;

  // Every inner-iterator name, known up front so that flag-arming stimuli
  // (arm-throw) can target an inner before the mapper call that produces it
  // has settled — the flag is just armed for later.
  const innerNames = new Set();
  for (const tick of scenario.ticks) {
    for (const step of tick.steps) {
      for (const ev of step.events) {
        if (ev.type === 'fn-settle' && 'iterator' in ev) innerNames.add(ev.iterator);
      }
    }
  }

  // per-iterator bookkeeping ('source' or an inner handle)
  const iter = new Map();
  const iterState = (target) => {
    if (target !== 'source' && !innerNames.has(target)) return null;
    if (!iter.has(target)) {
      iter.set(target, { nextIndex: 0, returnIndex: 0, heldQueue: [] });
    }
    return iter.get(target);
  };

  let nextRow = 0;   // result rows, in order of `next` events
  let pullRow = 0;   // underlying rows, in order of (non-throwing) `pull` events
  let fnIndex = 0;   // fn invocation counter (controlledFn numbering)
  const forwardSettles = []; // settles of pulls observed later in the same tick

  const events = []; // flattened: { ev, tick, step, category, ...derived }

  scenario.ticks.forEach((tick, t) => {
    let seenObservation = false;
    tick.steps.forEach((step, s) => {
      step.events.forEach((ev, e) => {
        const where = `tick ${t} step ${s} event ${e} (${ev.type})`;
        let category = STIMULI.has(ev.type) ? 'stimulus'
          : OBSERVATIONS.has(ev.type) ? 'observation'
          : ANNOTATIONS.has(ev.type) ? 'annotation'
          : DEFINITIONS.has(ev.type) ? 'definition'
          : null;
        if (category === null) {
          fail(where, `unknown event type`);
          return;
        }
        const entry = { ev, tick: t, step: s, category };

        switch (ev.type) {
          case 'next': {
            if (results.has(ev.result)) fail(where, `duplicate result handle ${ev.result}`);
            results.set(ev.result, { kind: 'next', row: nextRow++, settled: false });
            break;
          }
          case 'return': {
            if (results.has(ev.result)) fail(where, `duplicate result handle ${ev.result}`);
            results.set(ev.result, { kind: 'return', row: null, settled: false });
            break;
          }
          case 'pull': {
            if (pulls.has(ev.pull)) fail(where, `duplicate pull handle ${ev.pull}`);
            const st = iterState('source');
            if (ev.throws) {
              // matches controlledSource: a sync-throwing next() does not
              // consume an index and creates no promise
              entry.index = st.nextIndex;
              pulls.set(ev.pull, { kind: 'source', iterator: null, index: entry.index, row: null, throws: true, settled: true, tick: t });
            } else {
              entry.index = st.nextIndex++;
              entry.row = pullRow++;
              pulls.set(ev.pull, { kind: 'source', iterator: null, index: entry.index, row: entry.row, settled: false, tick: t });
            }
            break;
          }
          case 'inner-pull': {
            if (scenario.helper !== 'flatMap') fail(where, `inner-pull outside flatMap`);
            if (pulls.has(ev.pull)) fail(where, `duplicate pull handle ${ev.pull}`);
            const inner = inners.get(ev.iterator);
            if (!inner) { fail(where, `unknown inner iterator ${ev.iterator}`); break; }
            const st = iterState(ev.iterator);
            if (ev.throws) {
              entry.index = st.nextIndex;
              pulls.set(ev.pull, { kind: 'inner', iterator: ev.iterator, index: entry.index, row: inner.slot, col: null, throws: true, settled: true, tick: t });
            } else {
              entry.index = st.nextIndex++;
              entry.col = inner.pullCount++;
              pulls.set(ev.pull, { kind: 'inner', iterator: ev.iterator, index: entry.index, row: inner.slot, col: entry.col, settled: false, tick: t });
            }
            break;
          }
          case 'settle': {
            const p = pulls.get(ev.pull);
            if (!p) {
              // a pull can be settled before its observation is asserted, but
              // only within the same tick: that's the synchronous-pull idiom
              // (the .next() stimulus pulled the source synchronously, and the
              // tick's expectLog sees the pull after the fact)
              forwardSettles.push({ where, ev, tick: t });
            } else {
              if (p.settled) fail(where, `pull ${ev.pull} settled twice`);
              p.settled = true;
            }
            if (!('value' in ev) && !ev.done && !('error' in ev)) fail(where, `settle needs value, done, or error`);
            break;
          }
          case 'fn': {
            if (calls.has(ev.call)) fail(where, `duplicate call handle ${ev.call}`);
            const from = ev.from != null ? pulls.get(ev.from) : null;
            if (ev.from != null && !from) fail(where, `unknown pull ${ev.from}`);
            entry.index = fnIndex++;
            calls.set(ev.call, { index: entry.index, slot: from ? from.row : null, arg: ev.arg, settled: false });
            break;
          }
          case 'fn-settle': {
            usesFnSettle = true;
            const c = calls.get(ev.call);
            if (!c) { fail(where, `unknown call ${ev.call}`); break; }
            if (c.settled) fail(where, `call ${ev.call} settled twice`);
            c.settled = true;
            const has = (k) => k in ev;
            if (scenario.helper === 'filter' && !(has('verdict') || has('error'))) fail(where, `filter fn-settle needs verdict or error`);
            if (scenario.helper === 'map' && !(has('value') || has('error'))) fail(where, `map fn-settle needs value or error`);
            if (scenario.helper === 'flatMap' && !(has('iterator') || has('error'))) fail(where, `flatMap fn-settle needs iterator or error`);
            if (has('iterator')) {
              if (inners.has(ev.iterator)) fail(where, `duplicate inner iterator ${ev.iterator}`);
              else inners.set(ev.iterator, { slot: c.slot, pullCount: 0 });
            }
            break;
          }
          case 'fn-sync': {
            fnSync.push(ev);
            break;
          }
          case 'close': {
            const st = iterState(ev.target);
            if (!st) { fail(where, `unknown close target ${ev.target}`); break; }
            // matches controlledSource: .return() consumes an index even
            // when the armed sync throw fires, but a sync throw creates no
            // promise, so only a non-throwing close can later be settled
            entry.index = st.returnIndex++;
            if (!ev.throws) st.heldQueue.push(entry.index);
            break;
          }
          case 'close-settled': {
            // always a stimulus: settles (or rejects, with `error`) the next
            // outstanding non-throwing `.return()` on its target
            const st = iterState(ev.target);
            if (!st) { fail(where, `unknown close-settled target ${ev.target}`); break; }
            if (st.heldQueue.length === 0) {
              fail(where, `close-settled with no outstanding .return() on ${ev.target}`);
              break;
            }
            entry.heldIndex = st.heldQueue.shift();
            break;
          }
          case 'arm-throw': {
            const st = iterState(ev.target);
            if (!st) fail(where, `unknown arm-throw target ${ev.target}`);
            if (!['next', 'return'].includes(ev.on)) fail(where, `arm-throw needs on: 'next' | 'return'`);
            break;
          }
          case 'result': {
            const r = results.get(ev.result);
            if (!r) { fail(where, `unknown result ${ev.result}`); break; }
            if (r.settled) fail(where, `result ${ev.result} settled twice`);
            r.settled = true;
            if (ev.from != null && !calls.has(ev.from) && !pulls.has(ev.from)) {
              fail(where, `result.from ${ev.from} is neither a call nor a pull`);
            }
            if (!('value' in ev) && !ev.done && !('error' in ev)) fail(where, `result needs value, done, or error`);
            break;
          }
          case 'compact': case 'slot-error': {
            if (!pulls.has(ev.pull)) fail(where, `unknown pull ${ev.pull}`);
            break;
          }
          case 'void': {
            const ref = ev.pull ?? ev.call ?? ev.result;
            if (!pulls.has(ev.pull) && !calls.has(ev.call) && !results.has(ev.result)) {
              fail(where, `void target ${ref} unknown`);
            }
            break;
          }
          case 'open-closing': case 'tombstone':
            break;
        }

        // a tick's stimuli must all precede its observations
        if (category === 'observation') seenObservation = true;
        if (category === 'stimulus' && seenObservation) {
          fail(where, `stimulus after an observation in the same tick — split the tick here`);
        }

        events.push(entry);
      });
    });
  });

  for (const { where, ev, tick } of forwardSettles) {
    const p = pulls.get(ev.pull);
    if (!p) fail(where, `unknown pull ${ev.pull}`);
    else if (p.tick !== tick) fail(where, `pull ${ev.pull} settled before its observation, which is not in the same tick`);
    else if (p.settled) fail(where, `pull ${ev.pull} settled twice`);
    else p.settled = true;
  }

  if (fnSync.length > 0 && usesFnSettle) {
    errors.push(`scenario mixes fn-sync definitions with fn-settle stimuli`);
  }

  if (errors.length > 0) {
    throw new Error(`invalid scenario ${scenario.id}:\n  ` + errors.join('\n  '));
  }

  return { scenario, names, events, pulls, calls, results, inners, syncFn: fnSync.length > 0, fnSync };
}

const pr = new Intl.PluralRules('en-US', { type: 'ordinal' });

const suffixes = {
  one: 'st',
  two: 'nd',
  few: 'rd',
  other: 'th',
};

export function ord(n) {
  const num = n + 1;
  return `${num}${suffixes[pr.select(num)]}`;
}


// Narrate a list of events (one animation step, or one Interactive-tab tick)
// as a screen-reader sentence, using the resolved handle index from
// indexScenario. Plain prose only — no code or markdown — since an aria-live
// region reads it aloud verbatim. Returns '' when nothing in the list is
// audible (e.g. a step of pure visual chrome). Shared by the animation
// compiler (per step) and the live Interactive tab (per user action), so the
// spoken narration and the visuals are driven from one source.
export function narrateEvents(events, index) {
  const { names, scenario } = index;
  const display = (v) => String(v);
  const fnNoun = scenario.helper === 'filter' ? 'predicate' : 'mapper';
  const valPhrase = (ev) => {
    if ('error' in ev) return 'an error';
    if (ev.done) return 'done: true';
    return `value ${display(ev.value)}`;
  };
  const describe = (ev) => {
    switch (ev.type) {
      case 'next': {
        const r = index.results.get(ev.result);
        return `The consumer pulls a value; the ${ord(r.row)} promise in the Result column is now pending.`;
      }
      case 'return':
        return `The consumer closes the result iterator (calls return); its promise is now pending.`;
      case 'pull': {
        if (ev.throws) return null;
        const p = index.pulls.get(ev.pull);
        return `The helper pulls from the underlying iterator; the ${ord(p.row)} promise in the Underlying column is now pending.`;
      }
      case 'inner-pull': {
        if (ev.throws) return null;
        const p = index.pulls.get(ev.pull);
        return `The helper makes the ${ord(p.col)} pull from inner iterator ${ev.iterator}.`;
      }
      case 'settle': {
        const p = index.pulls.get(ev.pull);
        if (p.kind === 'inner')
          return `The ${ord(p.col)} pull from inner iterator ${p.iterator} settles with ${valPhrase(ev)}.`;
        return `The ${ord(p.row)} promise in the Underlying column settles with ${valPhrase(ev)}.`;
      }
      case 'fn': {
        const c = index.calls.get(ev.call);
        return `The ${fnNoun} ${names.fnDisplay} is called on ${display(ev.arg)}; the ${ord(c.slot)} promise in the Internal column is now pending.`;
      }
      case 'fn-settle': {
        const c = index.calls.get(ev.call);
        if ('error' in ev) return `The ${fnNoun} for the ${ord(c.slot)} value rejects with an error.`;
        if ('iterator' in ev) return `The ${fnNoun} for the ${ord(c.slot)} value returns inner iterator ${ev.iterator}.`;
        if ('verdict' in ev) return `The ${fnNoun} for the ${ord(c.slot)} value settles ${ev.verdict} (${ev.verdict ? 'keep it' : 'drop it'}).`;
        return `The ${ord(c.slot)} promise in the Internal column settles with value ${display(ev.value)}.`;
      }
      case 'result': {
        const r = index.results.get(ev.result);
        if (r.kind === 'return') {
          if ('error' in ev) return `The result iterator's return() promise rejects with an error.`;
          return `The result iterator's return() promise resolves with done: true.`;
        }
        return `The ${ord(r.row)} promise in the Result column resolves with ${valPhrase(ev)}.`;
      }
      case 'close': {
        if (ev.throws) return null;
        const who = ev.target === 'source' ? 'the underlying iterator' : `inner iterator ${ev.target}`;
        return `The helper calls return() on ${who}; its promise is now pending.`;
      }
      case 'close-settled': {
        const tgt = ev.target === 'source' ? 'underlying iterator' : 'inner iterator';
        if ('error' in ev) return `The ${tgt}'s return() rejects with an error.`;
        return `The ${tgt}'s return() resolves with done: true.`;
      }
      case 'tombstone':
        return `The ${ev.target === 'underlying' ? 'underlying' : 'result'} iterator is now marked closed.`;
      case 'compact':
        return `An exhausted internal slot is discarded; the remaining slots shift up.`;
      case 'void':
        return `A pending promise is voided; it will never deliver a value.`;
      case 'slot-error': {
        const p = index.pulls.get(ev.pull);
        return `The error propagates into the ${ord(p.row)} promise in the Internal column.`;
      }
      default:
        return null; // open-closing, arm-throw, fn-sync: nothing to announce
    }
  };
  const parts = [];
  for (const ev of events) {
    const s = describe(ev);
    if (s && !parts.includes(s)) parts.push(s); // dedupe (e.g. paired compacts/tombstones)
  }
  return parts.join(' ');
}

// The exact log line an observation produces, matching test/utils.js.
export function renderLogLine(entry, index) {
  const { ev } = entry;
  const { names } = index;
  const iterName = (target) => (target === 'source' ? names.source : target);
  switch (ev.type) {
    case 'pull':
      return `${names.source}.next() #${entry.index}${ev.throws ? ' (throws)' : ''}`;
    case 'inner-pull':
      return `${ev.iterator}.next() #${entry.index}${ev.throws ? ' (throws)' : ''}`;
    case 'fn':
      return index.syncFn
        ? `${names.fn}(${JSON.stringify(ev.arg)})`
        : `${names.fn}(${JSON.stringify(ev.arg)}) #${entry.index}`;
    case 'close':
      return `${iterName(ev.target)}.return() #${entry.index}${ev.throws ? ' (throws)' : ''}`;
    case 'result':
      if ('error' in ev) return `${ev.result} rejected ${ev.error}`;
      if (ev.done) return `${ev.result} resolved {"done":true}`;
      return `${ev.result} resolved ${JSON.stringify({ value: ev.value, done: false })}`;
    default:
      throw new Error(`not an observation: ${ev.type}`);
  }
}

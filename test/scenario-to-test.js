// Execute a scenario (see FORMAT.md) as a unit test.
//
// `scenarioTest(scenario, { helper, utils })` returns a `[name, fn]` entry
// compatible with `runTests` from the implementation repo's test/utils.js:
//
//   import * as utils from './utils.js';
//   import { filter } from '../filter.js';
//   tests.push(scenarioTest(myScenario, { helper: filter, utils }));
//
// `helper` is the combinator under test; `utils` must provide
// controlledSource, controlledFn, flushMicrotasks, and track.
//
// Each tick runs its stimuli in order, flushes microtasks, then asserts that
// exactly the tick's observations (in order) were logged.

import { indexScenario, renderLogLine } from '../scenario-core.js';

export function scenarioTest(scenario, { helper, utils }) {
  const name = `${scenario.helper} scenario ${scenario.id}: ${scenario.label}`;
  return [name, async function (t) {
    const index = indexScenario(scenario);
    const { names } = index;

    const src = utils.controlledSource(t.log, names.source);
    let fnCtl = null;
    let fn;
    if (index.syncFn) {
      // an uncontrolled synchronous fn, scripted by the fn-sync definitions;
      // unlogged, matching the plain inline fns the hand-written tests use
      fn = (x) => {
        const key = JSON.stringify(x);
        const d = index.fnSync.find((d) => JSON.stringify(d.arg) === key);
        if (!d) throw new Error(`scenario ${scenario.id}: no fn-sync behavior for ${key}`);
        if ('error' in d) throw new Error(d.error);
        return 'verdict' in d ? d.verdict : d.value;
      };
    } else {
      fnCtl = utils.controlledFn(t.log, names.fn);
      fn = fnCtl.fn;
    }

    const it = helper(src.iterator, fn);
    const ctls = new Map([['source', src]]); // iterator handle -> controlled source
    // inner controlled sources are created eagerly (creation is unobservable),
    // so flag-arming stimuli can reference them before the mapper settles
    for (const innerName of index.inners.keys()) {
      ctls.set(innerName, utils.controlledSource(t.log, innerName));
    }

    const dispatch = (entry) => {
      const { ev } = entry;
      switch (ev.type) {
        case 'next': {
          const p = it.next();
          if (!ev.untracked) utils.track(t.log, ev.result, p);
          break;
        }
        case 'return': {
          const p = it.return();
          if (!ev.untracked) utils.track(t.log, ev.result, p);
          break;
        }
        case 'settle': {
          const p = index.pulls.get(ev.pull);
          const ctl = ctls.get(p.kind === 'source' ? 'source' : p.iterator);
          if ('error' in ev) ctl.throw(p.index, new Error(ev.error));
          else if (ev.done) ctl.finish(p.index);
          else ctl.yield(p.index, ev.value);
          break;
        }
        case 'fn-settle': {
          const c = index.calls.get(ev.call);
          if ('error' in ev) fnCtl.reject(c.index, new Error(ev.error));
          else if ('iterator' in ev) fnCtl.resolve(c.index, ctls.get(ev.iterator).iterator);
          else fnCtl.resolve(c.index, 'verdict' in ev ? ev.verdict : ev.value);
          break;
        }
        case 'arm-throw': {
          const ctl = ctls.get(ev.target);
          if (!ctl) throw new Error(`scenario ${scenario.id}: arm-throw before ${ev.target} exists`);
          if (ev.on === 'next') ctl.throwNext(new Error(ev.error));
          else ctl.throwReturn(new Error(ev.error));
          break;
        }
        case 'close-settled': { // settles the next outstanding .return()
          const ctl = ctls.get(ev.target);
          if ('error' in ev) ctl.settleReturnThrow(entry.heldIndex, new Error(ev.error));
          else ctl.settleReturn(entry.heldIndex);
          break;
        }
        default:
          throw new Error(`scenario ${scenario.id}: unhandled stimulus ${ev.type}`);
      }
    };

    for (let ti = 0; ti < scenario.ticks.length; ti++) {
      const entries = index.events.filter((en) => en.tick === ti);
      for (const entry of entries) {
        if (entry.category === 'stimulus') dispatch(entry);
      }
      await utils.flushMicrotasks();
      const expected = entries
        .filter((en) => en.category === 'observation')
        .map((en) => renderLogLine(en, index));
      t.expectLog(scenario.ticks[ti].note ?? `tick ${ti}`, expected);
    }
  }];
}

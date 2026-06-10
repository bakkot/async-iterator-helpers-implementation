// Convert the hand-written unit tests (test/{map,filter,flatMap}.js — not the
// fuzzers) into scenario files (see
// ../../async-iterator-animations/scenarios/FORMAT.md).
//
// Run from the repo root:  node tools/convert-tests.js
//
// Strategy: record-replay, not parsing. Each test body is evaluated with
// recording stand-ins for the helper, controlledSource, controlledFn, track,
// and flushMicrotasks. Nothing actually executes — the stand-ins record the
// test's *stimuli* in order, and each t.expectLog() closes a tick whose
// *observations* are parsed from the expected log lines (which also carry the
// handle numbering). Tests this can't represent are reported and skipped:
// hand-rolled sources/iterators (detected by the helper receiving an unknown
// iterator, or direct t.log calls), yieldResult protocol abuse, t.check
// assertions, and async uncontrolled fns. Plain synchronous fns ARE
// supported: the real fn is evaluated once per distinct source value at
// conversion time to build the scenario's fn-sync table.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Skipped tests still run their bodies, and some reject bare
// Promise.withResolvers promises nothing ever observes.
process.on('unhandledRejection', () => {});

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, '..', 'async-iterator-animations', 'scenarios');

const CONFIGS = [
  { helper: 'map', file: 'test/map.js', out: 'map-test-scenarios.js', exportName: 'mapTestScenarios', idPrefix: 'map-test' },
  { helper: 'filter', file: 'test/filter.js', out: 'filter-test-scenarios.js', exportName: 'filterTestScenarios', idPrefix: 'filter-test' },
  { helper: 'flatMap', file: 'test/flatMap.js', out: 'flatmap-test-scenarios.js', exportName: 'flatMapTestScenarios', idPrefix: 'flatmap-test' },
];

const DEFAULT_FN_NAME = { map: 'fn', filter: 'pred', flatMap: 'm' };

// ---------------------------------------------------------------- extraction

// Pull the `tests` array out of a test file by evaluating its body with the
// imports stripped. The bodies only reference the identifiers we pass in.
function extractTests(file) {
  let src = readFileSync(join(root, file), 'utf8');
  src = src.replace(/^import[^;]*;/gm, '');
  src = src.replace(/^\s*(await\s+)?runTests\([^;]*;\s*$/m, '');
  src += '\nreturn { tests, xfailed };';
  const make = new Function(
    'map', 'filter', 'flatMap',
    'runTests', 'track', 'flushMicrotasks', 'controlledSource', 'controlledFn',
    src,
  );
  return make;
}

// ---------------------------------------------------------------- recorder

function makeRecorder(helperKind) {
  const rec = {
    ticks: [],
    stimuli: [],
    problems: [],
    fnSync: [],
    syncSeen: new Set(),
    syncFn: null,
    fnCtl: null,
    srcCtl: null,
    fnName: null,
    srcName: null,
    sources: [],            // every controlledSource created, in order
    srcByIterator: new Map(),
    innerNameByCtl: new Map(), // ctl -> inner handle name (its log name)
    pullHandles: new Map(),    // `${target}\0${index}` -> handle
    throwingPulls: 0,
    pendingLabels: new Map(),  // marker promise -> next/return event
    autoNames: 0,
    valueMatches: [],          // {key, handle, used}   (fn.from)
    deliverables: [],          // {key, from, used}     (result.from)
    callArgs: new Map(),       // call handle -> arg
    notes: [],
  };
  const fail = (msg) => { if (!rec.problems.includes(msg)) rec.problems.push(msg); };
  rec.fail = fail;

  const targetOf = (ctl) => (ctl === rec.srcCtl ? 'source' : ctl.__name);
  const pullHandle = (ctl, i) => {
    const h = rec.pullHandles.get(`${targetOf(ctl)}\0${i}`);
    if (h == null) fail(`settles pull #${i} of ${targetOf(ctl)} before it was observed`);
    return h;
  };

  const recordSettle = (ctl, i, fields, value) => {
    const h = pullHandle(ctl, i);
    rec.stimuli.push({ type: 'settle', pull: h, ...fields });
    if ('value' in fields && targetOf(ctl) === 'source') {
      rec.valueMatches.push({ key: JSON.stringify(value), handle: h, used: false });
      if (rec.syncFn) tabulateSync(value);
    }
    if ('value' in fields && targetOf(ctl) !== 'source') {
      // a settled inner value is a deliverable for some later result
      rec.deliverables.push({ key: JSON.stringify(value), from: h, used: false });
    }
  };

  function tabulateSync(value) {
    const key = JSON.stringify(value);
    if (rec.syncSeen.has(key)) return;
    rec.syncSeen.add(key);
    const def = { type: 'fn-sync', arg: value };
    try {
      const r = rec.syncFn(value);
      if (r != null && typeof r.then === 'function') { fail('uncontrolled async fn'); return; }
      if (helperKind === 'filter') def.verdict = r;
      else if (helperKind === 'map') def.value = r;
      else { fail('sync flatMap mapper returning an iterator'); return; }
      if (helperKind === 'filter' && r === true) {
        rec.deliverables.push({ key, from: undefined, used: false });
      }
      if (helperKind === 'map') {
        rec.deliverables.push({ key: JSON.stringify(r), from: undefined, used: false });
      }
    } catch (e) {
      def.error = e.message;
    }
    rec.fnSync.push(def);
  }

  rec.controlledSource = (log, name = 'src') => {
    const ctl = {
      __name: name,
      iterator: { __ctl: null },
      yield: (i, value) => recordSettle(ctl, i, { value }, value),
      finish: (i) => recordSettle(ctl, i, { done: true }),
      throw: (i, err) => recordSettle(ctl, i, { error: err.message }),
      yieldResult: () => fail('yieldResult (raw iterator-result injection)'),
      throwNext: (err) => rec.stimuli.push({ type: 'arm-throw', target: targetOf(ctl), on: 'next', error: err.message }),
      throwReturn: (err) => rec.stimuli.push({ type: 'arm-throw', target: targetOf(ctl), on: 'return', error: err.message }),
      holdReturn: () => rec.stimuli.push({ type: 'hold-close', target: targetOf(ctl) }),
      settleReturn: () => rec.stimuli.push({ type: 'close-settled', target: targetOf(ctl) }),
      settleReturnThrow: (i, err) => rec.stimuli.push({ type: 'close-settled', target: targetOf(ctl), error: err.message }),
    };
    ctl.iterator = new Proxy(ctl.iterator, {
      deleteProperty(target, key) {
        fail(`deletes iterator.${String(key)} (protocol-shape test)`);
        delete target[key];
        return true;
      },
    });
    ctl.iterator.__ctl = ctl;
    rec.sources.push(ctl);
    rec.srcByIterator.set(ctl.iterator, ctl);
    return ctl;
  };

  rec.controlledFn = (log, name = 'fn') => {
    const fn = (..._args) => fail('the controlled fn was invoked during recording');
    const ctl = {
      fn,
      __name: name,
      resolve: (i, mapped) => {
        const call = `p${i}`;
        const ev = { type: 'fn-settle', call };
        if (helperKind === 'flatMap') {
          const innerCtl = mapped != null ? rec.srcByIterator.get(mapped) : null;
          if (!innerCtl) { fail('mapper resolved with a non-controlled inner iterator'); return; }
          ev.iterator = innerCtl.__name;
        } else if (helperKind === 'filter') {
          ev.verdict = mapped;
          if (mapped === true) {
            rec.deliverables.push({ key: JSON.stringify(rec.callArgs.get(call)), from: call, used: false });
          }
        } else {
          ev.value = mapped;
          rec.deliverables.push({ key: JSON.stringify(mapped), from: call, used: false });
        }
        rec.stimuli.push(ev);
      },
      reject: (i, err) => rec.stimuli.push({ type: 'fn-settle', call: `p${i}`, error: err.message }),
    };
    rec.fnByFn ??= new Map();
    rec.fnByFn.set(fn, ctl);
    return ctl;
  };

  rec.helper = (it, fn) => {
    const srcCtl = rec.srcByIterator.get(it);
    if (!srcCtl) fail('helper called with a hand-rolled source');
    else { rec.srcCtl = srcCtl; rec.srcName = srcCtl.__name; }
    const fnCtl = rec.fnByFn?.get(fn);
    if (fnCtl) { rec.fnCtl = fnCtl; rec.fnName = fnCtl.__name; }
    else if (typeof fn === 'function') rec.syncFn = fn;
    else fail('helper called without a usable fn');
    const vend = (type) => {
      const marker = Promise.resolve(); // a unique, thenable-looking token
      const ev = { type, result: null };
      rec.stimuli.push(ev);
      rec.pendingLabels.set(marker, ev);
      return marker;
    };
    return { next: () => vend('next'), return: () => vend('return') };
  };

  rec.track = (log, label, promise) => {
    const ev = rec.pendingLabels.get(promise);
    if (ev) ev.result = label;
    else fail('track() on a promise the recorder did not vend');
    return promise;
  };

  rec.flushMicrotasks = async () => {};

  const matchFirst = (list, key) => {
    const hit = list.find((x) => !x.used && x.key === key);
    if (hit) { hit.used = true; return hit.from ?? hit.handle; }
    return undefined;
  };

  function parseLine(line) {
    let m;
    if ((m = /^(\S+)\.next\(\) #(\d+)( \(throws\))?$/.exec(line))) {
      const [, name, idxs, throws] = m;
      const idx = +idxs;
      const isSource = name === rec.srcName;
      const base = isSource ? `u${idx}` : `${name.toLowerCase()}${idx}`;
      const handle = throws ? `${base}-throw${rec.throwingPulls++}` : base;
      const target = isSource ? 'source' : name;
      if (!throws) rec.pullHandles.set(`${target}\0${idx}`, handle);
      const ev = isSource
        ? { type: 'pull', pull: handle }
        : { type: 'inner-pull', pull: handle, iterator: name };
      if (throws) ev.throws = true;
      return ev;
    }
    if ((m = /^(\S+)\.return\(\) #(\d+)( \(throws\))?$/.exec(line))) {
      const [, name, , throws] = m;
      const ev = { type: 'close', target: name === rec.srcName ? 'source' : name };
      if (throws) ev.throws = true;
      return ev;
    }
    if ((m = /^(\S+)\((.*)\) #(\d+)$/.exec(line)) && m[1] === rec.fnName) {
      const arg = JSON.parse(m[2]);
      const call = `p${m[3]}`;
      rec.callArgs.set(call, arg);
      const ev = { type: 'fn', call, arg };
      const from = matchFirst(rec.valueMatches, JSON.stringify(arg));
      if (from !== undefined) ev.from = from;
      return ev;
    }
    if ((m = /^(\S+) (resolved|rejected) (.*)$/.exec(line))) {
      const [, name, kind, rest] = m;
      if (kind === 'rejected') return { type: 'result', result: name, error: rest };
      const obj = JSON.parse(rest);
      if (obj.done === true) {
        if ('value' in obj) { rec.fail(`done result carrying a value: ${line}`); return null; }
        return { type: 'result', result: name, done: true };
      }
      const ev = { type: 'result', result: name, value: obj.value };
      const from = matchFirst(rec.deliverables, JSON.stringify(obj.value));
      if (from !== undefined) ev.from = from;
      return ev;
    }
    rec.fail(`unparseable expected log line: ${line}`);
    return null;
  }

  rec.t = {
    log: () => fail('direct t.log (hand-rolled instrumentation)'),
    // t.check is an out-of-log assertion (usually `x instanceof Promise`);
    // it cannot be represented, but losing it doesn't invalidate the rest of
    // the test — the original suite still asserts it. Note and continue.
    check: (label) => rec.notes.push(`dropped t.check: ${label}`),
    expectLog: (label, expected) => {
      for (const ev of rec.stimuli) {
        if ((ev.type === 'next' || ev.type === 'return') && ev.result == null) {
          // the original test never track()ed this promise, so its settlement
          // must not be logged either
          ev.result = `untracked${rec.autoNames++}`;
          ev.untracked = true;
        }
      }
      const observations = expected.map(parseLine).filter((x) => x != null);
      rec.ticks.push({ note: label, steps: [{ events: [...rec.stimuli, ...observations] }] });
      rec.stimuli = [];
    },
  };

  rec.finish = () => {
    if (rec.stimuli.length > 0) fail('trailing stimuli after the last expectLog');
  };

  return rec;
}

// ---------------------------------------------------------------- serialize

const q = (s) => JSON.stringify(s);
function printEvent(ev) {
  return `{ ${Object.entries(ev).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} }`;
}
function printScenario(s) {
  const lines = [];
  lines.push('  {');
  lines.push(`    id: ${q(s.id)},`);
  lines.push(`    helper: ${q(s.helper)},`);
  lines.push(`    label: ${q(s.label)},`);
  lines.push('    ticks: [');
  for (const tick of s.ticks) {
    lines.push(`      { note: ${q(tick.note)}, steps: [ { events: [`);
    for (const ev of tick.steps[0].events) lines.push(`        ${printEvent(ev)},`);
    lines.push('      ] } ] },');
  }
  lines.push('    ],');
  lines.push('  },');
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

for (const cfg of CONFIGS) {
  const make = extractTests(cfg.file);
  const scenarios = [];
  const skipped = [];

  // The body is evaluated once; the stand-ins dispatch to whichever
  // recorder is current, so each test gets a fresh one.
  let rec = null;
  const dispatch = (method) => (...args) => rec[method](...args);
  const { tests } = make(
    dispatch('helper'), dispatch('helper'), dispatch('helper'),
    () => {}, dispatch('track'), async () => {}, dispatch('controlledSource'), dispatch('controlledFn'),
  );

  let n = 0;
  for (const [name, fn] of tests) {
    n++;
    rec = makeRecorder(cfg.helper);
    try {
      await fn(rec.t);
      rec.finish();
    } catch (e) {
      rec.fail(`threw during recording: ${e.message}`);
    }
    if (rec.problems.length > 0) {
      skipped.push([name, rec.problems]);
      continue;
    }
    for (const note of rec.notes) console.log(`  note (${name}): ${note}`);
    const scenario = {
      id: `${cfg.idPrefix}-${String(n).padStart(3, '0')}`,
      helper: cfg.helper,
      label: name,
      ticks: rec.ticks,
    };
    if (rec.fnSync.length > 0) {
      scenario.ticks[0]?.steps[0]?.events.unshift(...rec.fnSync);
    }
    scenarios.push(scenario);
  }

  const body = [
    `// GENERATED from ${cfg.file} (async-iterator-implementation) by tools/convert-tests.js.`,
    `// Rerunning the converter overwrites this file.`,
    '',
    `export const ${cfg.exportName} = [`,
    ...scenarios.map(printScenario),
    '];',
    '',
  ].join('\n');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, cfg.out), body);

  console.log(`${cfg.file}: converted ${scenarios.length}/${tests.length} -> scenarios/${cfg.out}`);
  for (const [name, problems] of skipped) {
    console.log(`  skipped: ${name}`);
    for (const p of problems) console.log(`      ${p}`);
  }
}

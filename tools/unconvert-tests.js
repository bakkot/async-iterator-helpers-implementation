// Render the scenario test files (../../async-iterator-animations/scenarios/
// *-test-scenarios.js — the source of truth, converted 2026-06-10 from the
// since-deleted hand-written test/{map,filter,flatMap}.js) back into the old
// hand-written style, for review:
//
//   node tools/unconvert-tests.js     # writes test/roundtrip-{map,filter,flatMap}.js
//
// The roundtrip files are directly runnable (node test/roundtrip-map.js) but
// are review artifacts, not part of the suite; regenerate rather than edit.
// Lossy by design: the originals' variable names, whitespace/grouping,
// sync-fn bodies (rebuilt as lookup tables from the fn-sync defs),
// untracked-promise variable names, and .return() arguments did not survive
// conversion; verbatim-copied tests come back exactly as written.
//
// Scenario pushes are recovered by evaluating the file body with a stub
// scenarioTest (the scenario objects are plain literals); verbatim pushes
// and all comments are recovered positionally from the source text, mirroring
// the original converter's comment placement (header / per-test lead /
// per-tick).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { indexScenario, renderLogLine } from '../../async-iterator-animations/scenarios/scenario-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const scenariosDir = join(root, '..', 'async-iterator-animations', 'scenarios');

const CONFIGS = [
  { helper: 'map', helperFile: 'map.js', itVar: 'mapped', src: 'map-test-scenarios.js', out: 'test/roundtrip-map.js' },
  { helper: 'filter', helperFile: 'filter.js', itVar: 'f', src: 'filter-test-scenarios.js', out: 'test/roundtrip-filter.js' },
  { helper: 'flatMap', helperFile: 'flatMap.ts', itVar: 'fm', src: 'flatmap-test-scenarios.js', out: 'test/roundtrip-flatMap.js' },
];

const lit = (v) => inspect(v, { depth: Infinity, compact: true, breakLength: Infinity });

// ---------------------------------------------------------------- extraction

// Evaluate the generated file's body with a stub scenarioTest, recovering the
// tests array: scenario pushes become { __scenario } markers, verbatim pushes
// stay [name, fn] pairs. Order matches the source's push order.
function extractTests(srcText) {
  let src = srcText.replace(/^import[^;]*;/gm, '');
  src = src.replace(/^await runTests\([^;]*;\s*$/m, '');
  const make = new Function(
    'scenarioTest', 'map', 'filter', 'flatMap', 'utils',
    'runTests', 'track', 'flushMicrotasks', 'controlledSource', 'controlledFn',
    src + '\nreturn tests;',
  );
  const stub = () => {};
  return make((scenario) => ({ __scenario: scenario }), stub, stub, stub, {}, stub, stub, stub, stub, stub);
}

// Locate every push's source span and recover the comments: the file banner
// (the comment block starting at line 0) and [copied verbatim] markers are
// dropped; other runs become file-header comments, per-push lead comments,
// or (inside a scenario push) per-tick comments keyed by the count of
// `{ note:` lines above them.
function analyzeSource(srcText) {
  const lines = srcText.split('\n');
  const pushes = []; // { kind: 'scenario' | 'verbatim', start, end }
  for (let i = 0; i < lines.length; i++) {
    if (/^tests\.push\(scenarioTest\(\{/.test(lines[i])) {
      let end = i;
      while (end < lines.length && !/^\}, \{ helper: \w+, utils \}\)\);/.test(lines[end])) end++;
      if (end === lines.length) throw new Error(`unterminated scenarioTest push at line ${i + 1}`);
      pushes.push({ kind: 'scenario', start: i, end });
      i = end;
    } else if (/^tests\.push\(\[/.test(lines[i])) {
      let end = i;
      while (end < lines.length && !/^\}\]\);/.test(lines[end])) end++;
      if (end === lines.length) throw new Error(`unterminated verbatim push at line ${i + 1}`);
      pushes.push({ kind: 'verbatim', start: i, end, source: lines.slice(i, end + 1).join('\n') });
      i = end;
    }
  }

  const isComment = (i) => /^\s*\/\//.test(lines[i]);
  const isMarker = (l) => /^\/\/ \[copied verbatim/.test(l) || /^\/\/ {3}reason:/.test(l);

  const header = [];
  const perPush = pushes.map(() => ({ lead: [], ticks: new Map() }));
  for (let i = 0; i < lines.length; i++) {
    if (!isComment(i)) continue;
    const start = i;
    const text = [];
    while (i < lines.length && isComment(i)) text.push(lines[i++].replace(/^\s*/, ''));
    if (start === 0) continue; // the file banner
    const run = text.filter((l) => !isMarker(l));
    if (run.length === 0) continue;
    const inPush = pushes.findIndex((p) => start > p.start && i - 1 <= p.end);
    if (inPush !== -1) {
      if (pushes[inPush].kind === 'verbatim') continue; // already part of the copied source
      let tick = 0;
      for (let j = pushes[inPush].start; j < start; j++) {
        if (/^ {4}\{ note:/.test(lines[j])) tick++;
      }
      const m = perPush[inPush].ticks;
      m.set(tick, [...(m.get(tick) ?? []), run]);
      continue;
    }
    const next = pushes.findIndex((p) => p.start > start);
    if (next === -1) header.push(run);
    else if (pushes[next].start === i || next > 0) perPush[next].lead.push(run);
    else header.push(run);
  }
  return { pushes, header, perPush };
}

// ---------------------------------------------------------------- generation

// Rebuild an uncontrolled sync fn from the scenario's fn-sync table.
function syncFnText(fnSync, helper) {
  const branches = fnSync.map((d) => {
    const prim = d.arg === null || typeof d.arg !== 'object';
    const cond = prim ? `x === ${lit(d.arg)}` : `JSON.stringify(x) === ${lit(JSON.stringify(d.arg))}`;
    if ('error' in d) return `if (${cond}) throw new Error(${lit(d.error)});`;
    return `if (${cond}) return ${lit('verdict' in d ? d.verdict : d.value)};`;
  });
  const oneLine = `(x) => { ${branches.join(' ')} }`;
  if (oneLine.length <= 70) return oneLine;
  return `(x) => {\n${branches.map((b) => `    ${b}`).join('\n')}\n  }`;
}

function generateTest(scenario, cfg, tickComments) {
  const index = indexScenario(scenario);
  const { names } = index;
  const srcVar = names.source;
  const fnVar = names.fn;
  const it = cfg.itVar;
  const body = [];
  const declared = new Set(['source']);
  const ctlVar = (target) => (target === 'source' ? srcVar : target);
  const ensureInner = (target) => {
    if (declared.has(target)) return;
    declared.add(target);
    body.push(`  const ${target} = controlledSource(t.log, '${target}');`);
  };

  body.push(`  const ${srcVar} = controlledSource(t.log, '${srcVar}');`);
  if (index.syncFn) {
    body.push(`  const ${it} = ${cfg.helper}(${srcVar}.iterator, ${syncFnText(index.fnSync, cfg.helper)});`);
  } else {
    body.push(`  const ${fnVar} = controlledFn(t.log, '${fnVar}');`);
    body.push(`  const ${it} = ${cfg.helper}(${srcVar}.iterator, ${fnVar}.fn);`);
  }

  for (let ti = 0; ti < scenario.ticks.length; ti++) {
    body.push('');
    for (const run of tickComments.get(ti) ?? []) {
      for (const line of run) body.push(`  ${line}`);
    }
    const entries = index.events.filter((en) => en.tick === ti);
    const stimuli = entries.filter((en) => en.category === 'stimulus');
    for (let si = 0; si < stimuli.length; si++) {
      const entry = stimuli[si];
      const ev = entry.ev;
      switch (ev.type) {
        case 'next':
        case 'return': {
          // batch a run of consecutive consumer calls the way the originals
          // do: all the calls first, then all the track()s
          const run = [ev];
          while (si + 1 < stimuli.length && ['next', 'return'].includes(stimuli[si + 1].ev.type)) {
            run.push(stimuli[++si].ev);
          }
          for (const e of run) {
            const call = `${it}.${e.type}()`;
            if (e.untracked) body.push(`  ${call};`);
            else body.push(`  const ${e.result} = ${call};`);
          }
          for (const e of run) {
            if (!e.untracked) body.push(`  track(t.log, '${e.result}', ${e.result});`);
          }
          break;
        }
        case 'settle': {
          const p = index.pulls.get(ev.pull);
          const v = p.kind === 'source' ? srcVar : p.iterator;
          if ('error' in ev) body.push(`  ${v}.throw(${p.index}, new Error(${lit(ev.error)}));`);
          else if (ev.done) body.push(`  ${v}.finish(${p.index});`);
          else body.push(`  ${v}.yield(${p.index}, ${lit(ev.value)});`);
          break;
        }
        case 'fn-settle': {
          const c = index.calls.get(ev.call);
          if ('error' in ev) body.push(`  ${fnVar}.reject(${c.index}, new Error(${lit(ev.error)}));`);
          else if ('iterator' in ev) {
            ensureInner(ev.iterator);
            body.push(`  ${fnVar}.resolve(${c.index}, ${ev.iterator}.iterator);`);
          } else {
            body.push(`  ${fnVar}.resolve(${c.index}, ${lit('verdict' in ev ? ev.verdict : ev.value)});`);
          }
          break;
        }
        case 'arm-throw': {
          if (ev.target !== 'source') ensureInner(ev.target);
          const method = ev.on === 'next' ? 'throwNext' : 'throwReturn';
          body.push(`  ${ctlVar(ev.target)}.${method}(new Error(${lit(ev.error)}));`);
          break;
        }
        case 'hold-close': {
          if (ev.target !== 'source') ensureInner(ev.target);
          body.push(`  ${ctlVar(ev.target)}.holdReturn();`);
          break;
        }
        case 'close-settled': {
          if ('error' in ev) body.push(`  ${ctlVar(ev.target)}.settleReturnThrow(${entry.heldIndex}, new Error(${lit(ev.error)}));`);
          else body.push(`  ${ctlVar(ev.target)}.settleReturn(${entry.heldIndex});`);
          break;
        }
        default:
          throw new Error(`scenario ${scenario.id}: unhandled stimulus ${ev.type}`);
      }
    }
    body.push('  await flushMicrotasks();');
    const expected = entries
      .filter((en) => en.category === 'observation')
      .map((en) => lit(renderLogLine(en, index)));
    const note = lit(scenario.ticks[ti].note ?? `tick ${ti}`);
    const oneLine = `  t.expectLog(${note}, [${expected.join(', ')}]);`;
    // the originals' wrapping is inconsistent; 100 empirically minimizes
    // the diff against them
    if (oneLine.length <= 100) body.push(oneLine);
    else {
      body.push(`  t.expectLog(${note}, [`);
      for (const line of expected) body.push(`    ${line},`);
      body.push('  ]);');
    }
  }

  return [
    `tests.push([${lit(scenario.label)}, async function (t) {`,
    ...body,
    '}]);',
  ].join('\n');
}

// ---------------------------------------------------------------- main

for (const cfg of CONFIGS) {
  const srcText = readFileSync(join(scenariosDir, cfg.src), 'utf8');
  const tests = extractTests(srcText);
  const { pushes, header, perPush } = analyzeSource(srcText);
  if (tests.length !== pushes.length) {
    throw new Error(`${cfg.src}: ${tests.length} evaluated tests but ${pushes.length} source pushes`);
  }

  const emitted = [];
  tests.forEach((test, i) => {
    const chunk = [];
    for (const run of perPush[i].lead) chunk.push(...run);
    if (test.__scenario) {
      if (pushes[i].kind !== 'scenario') throw new Error(`${cfg.src}: push ${i} kind mismatch`);
      chunk.push(generateTest(test.__scenario, cfg, perPush[i].ticks));
    } else {
      if (pushes[i].kind !== 'verbatim') throw new Error(`${cfg.src}: push ${i} kind mismatch`);
      chunk.push(pushes[i].source);
    }
    emitted.push(chunk.join('\n'));
  });

  const headerLines = [];
  for (const run of header) {
    if (headerLines.length > 0) headerLines.push('');
    headerLines.push(...run);
  }

  const body = [
    `// GENERATED from scenarios/${cfg.src} by tools/unconvert-tests.js: the`,
    '// scenario tests rendered back in the old hand-written style, for review.',
    '// Runnable, but not part of the suite; regenerate rather than edit.',
    '',
    `import { ${cfg.helper} } from '../${cfg.helperFile}';`,
    'import {',
    '  runTests,',
    '  track,',
    '  flushMicrotasks,',
    '  controlledSource,',
    '  controlledFn,',
    "} from './utils.js';",
    '',
    'let tests = [];',
    'let xfailed = [];',
    ...(headerLines.length > 0 ? ['', ...headerLines] : []),
    '',
    emitted.join('\n\n'),
    '',
    'runTests(tests, xfailed);',
    '',
  ].join('\n');
  writeFileSync(join(root, cfg.out), body);
  console.log(`${cfg.src}: ${tests.length} tests -> ${cfg.out}`);
}

// Compile a scenario (see FORMAT.md) into the `{ id, label, description,
// content, steps }` object the index.html player consumes. The visual
// conventions (which classes to toggle, where things sit, how compaction
// climbs) are exactly the hand-written ones documented in the repo CLAUDE.md;
// this module is their single executable encoding.
//
// Throws if the scenario doesn't fit the diagram (more than 4 result rows /
// underlying pulls / inner pulls per iterator, or constructs with no visual
// convention, like sync-throwing pulls). Such scenarios are still valid as
// tests — they just can't be animated.

import { indexScenario } from '../../scenario-core.js';

const MAX_ROWS = 4; // u0..u3, r0..r3, m{row}0..3

export function scenarioToAnimation(scenario) {
  const index = indexScenario(scenario);
  const { names } = index;
  const records = scenario.display?.records ?? false;

  const content = {};
  const setContent = (box, field, text) => {
    (content[box] ??= {})[field] = text;
  };
  const display = (v) => String(v);
  const valFor = (ev) => {
    if ('error' in ev) return 'Error';
    if (ev.done) return { done: 'true' };
    return records ? { done: 'false', value: display(ev.value) } : display(ev.value);
  };

  // ---- screen-reader narration ----------------------------------------
  // Each step carries an `aria` sentence (or two) describing the changes it
  // makes, fed to the page's aria-live region so a non-visual consumer hears
  // what the SVG just did. Built from the same structured events that drive
  // the visuals, so the two never drift. Plain prose only (no code/markdown):
  // the live region is read aloud verbatim.
  const ord = (n) => ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'][n] ?? `${n + 1}th`;
  const fnNoun = scenario.helper === 'filter' ? 'predicate' : 'mapper';
  const valPhrase = (ev) => {
    if ('error' in ev) return 'an error';
    if (ev.done) return 'done: true';
    return `value ${display(ev.value)}`;
  };
  // describe one event as a sentence, or null for events with no audible
  // meaning (pure chrome like the band sliding open, or armings with no effect)
  const describeEvent = (ev) => {
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
  const ariaFor = (events) => {
    const parts = [];
    for (const ev of events) {
      const s = describeEvent(ev);
      if (s && !parts.includes(s)) parts.push(s); // dedupe (e.g. paired compacts)
    }
    return parts.join(' ');
  };

  // A dot-preview beat (spliced in below) shows where the *next* step will act
  // but changes nothing itself. Narrate it by naming the dotted target(s).
  const joinList = (xs) =>
    xs.length <= 1 ? (xs[0] ?? '')
      : xs.length === 2 ? `${xs[0]} and ${xs[1]}`
      : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
  const describeDot = (t) => {
    if (t.label === 'result') return 'the Result column (a new pull is about to be made)';
    if (t.label === 'return') return "the result iterator's return() (about to be called)";
    const box = t.box;
    if (box === 'c0') return "the underlying iterator's return() (about to settle)";
    if (box === 'c2') return "an inner iterator's return() (about to settle)";
    if (box[0] === 'm') {
      // m{slot}{col}: resolve the slot back to the inner iterator sitting there
      const slot = +box[1], col = +box[2];
      let handle = null;
      for (const [h, inner] of index.inners) if (inner.slot === slot) handle = h;
      return handle != null
        ? `the ${ord(col)} pull from inner iterator ${handle} (about to settle)`
        : 'an inner-iterator pull (about to settle)';
    }
    const colName = { u: 'Underlying', i: 'Internal', r: 'Result' }[box[0]] ?? '';
    return `the ${ord(+box.slice(1))} promise in the ${colName} column (about to settle)`;
  };
  // The first preview in an animation explains the marker; later ones, which
  // recur every other beat, drop the boilerplate down to a terse "Next: …".
  const ariaForDots = (dots, terse) => {
    const list = joinList(dots.map(describeDot));
    return terse ? `Next: ${list}.` : `A marker shows where the next step will act: ${list}.`;
  };

  // A scenario that uses the teardown band (a `return` or `close`) but never
  // explicitly slides it in (`open-closing`) starts with the band already open,
  // rather than having it pop in the instant the first close happens. We seed
  // `bandOpen` so the implicit-open in `return` stays quiet and emit the open as
  // base ops (applied at every step, including the idle step 0).
  let usesClosing = false, hasExplicitOpen = false;
  for (const tick of scenario.ticks)
    for (const step of tick.steps)
      for (const ev of step.events) {
        if (ev.type === 'return' || ev.type === 'close') usesClosing = true;
        if (ev.type === 'open-closing') hasExplicitOpen = true;
      }
  const startOpen = usesClosing && !hasExplicitOpen;

  // visual state
  const boxState = new Map(); // box key -> 'pending' | 'settled'
  const gone = new Set();     // compacted-away Internal element indices
  let sparesSpawned = 0;      // i4, i5
  const upLevel = new Map();  // Internal element index -> current +upN
  let bandOpen = startOpen;

  const visualRow = (slot) => {
    let n = slot;
    for (const g of gone) if (g < slot) n--;
    return n;
  };

  // the closing band has one box for an inner iterator's .return() (#c2);
  // it can host only a single inner close per animation
  let c2Inner = null;

  const notAnimatable = (msg) => {
    throw new Error(`scenario ${scenario.id} is not animatable: ${msg}`);
  };

  const pullBox = (p) => (p.kind === 'source' ? `u${p.row}` : `m${p.row}${p.col}`);

  const steps = [];

  scenario.ticks.forEach((tick) => {
    tick.steps.forEach((step) => {
      const ops = [];
      const arrows = [];
      // The stimuli this step performs, recorded as yellow-dot targets so the
      // *previous* step can preview "you're about to poke this" — the same dot
      // the Interactive tab puts on a settleable promise. A `box` target dots
      // that box's corner; a `label` target ('result'/'return') dots just left
      // of the Result / result.return() column header (no box exists yet).
      const stim = [];

      for (const ev of step.events) {
        switch (ev.type) {
          case 'next': {
            const r = index.results.get(ev.result);
            if (r.row >= MAX_ROWS) notAnimatable(`result row ${r.row} out of range`);
            ops.push([`#r${r.row} .box`, '+pending']);
            boxState.set(`r${r.row}`, 'pending');
            stim.push({ label: 'result' });
            break;
          }
          case 'return': {
            if (!bandOpen) { // implicit open if no explicit open-closing preceded
              ops.push(['#main', '+shifted'], ['#closing', '+shown']);
              bandOpen = true;
            }
            ops.push(['#c1 .box', '+pending']);
            boxState.set('c1', 'pending');
            setContent('c1', 'val', '{}');
            stim.push({ label: 'return' });
            break;
          }
          case 'pull': {
            if (ev.throws) notAnimatable('sync-throwing pull has no visual convention');
            const p = index.pulls.get(ev.pull);
            if (p.row >= MAX_ROWS) notAnimatable(`underlying row ${p.row} out of range`);
            ops.push([`#u${p.row} .box`, '+pending']);
            boxState.set(`u${p.row}`, 'pending');
            break;
          }
          case 'inner-pull': {
            if (ev.throws) notAnimatable('sync-throwing inner pull has no visual convention');
            const p = index.pulls.get(ev.pull);
            if (p.col >= MAX_ROWS) notAnimatable(`inner pull column ${p.col} out of range for ${ev.iterator}`);
            ops.push([`#m${p.row}${p.col} .box`, '+pending']);
            boxState.set(`m${p.row}${p.col}`, 'pending');
            break;
          }
          case 'settle': {
            const p = index.pulls.get(ev.pull);
            const box = pullBox(p);
            const spec = 'error' in ev ? '-pending +settled +errored' : '-pending +settled';
            ops.push([`#${box} .box`, spec], [`#${box} .val`, '+reveal']);
            boxState.set(box, 'settled');
            setContent(box, 'val', valFor(ev));
            stim.push({ box });
            break;
          }
          case 'fn': {
            const c = index.calls.get(ev.call);
            if (c.slot == null) notAnimatable(`fn call ${ev.call} has no 'from' pull (needed to place it)`);
            ops.push([`#i${c.slot} .box`, '+pending'], [`#i${c.slot} .label`, '+reveal']);
            if (scenario.helper !== 'flatMap') ops.push([`#i${c.slot} .divider`, '+reveal']);
            boxState.set(`i${c.slot}`, 'pending');
            setContent(`i${c.slot}`, 'label', `${names.fnDisplay}(${display(ev.arg)})`);
            const from = index.pulls.get(ev.from);
            arrows.push([`U${from.row}`, `I${visualRow(c.slot)}`]);
            break;
          }
          case 'fn-settle': {
            const c = index.calls.get(ev.call);
            const el = `i${c.slot}`;
            stim.push({ box: el });
            if ('error' in ev) {
              ops.push([`#${el} .box`, '-pending +settled +errored'], [`#${el} .label`, '-reveal']);
              if (scenario.helper !== 'flatMap') ops.push([`#${el} .divider`, '-reveal']);
              ops.push([`#${el} .err`, '+reveal']);
              boxState.set(el, 'settled');
              setContent(el, 'err', 'Error');
            } else if ('iterator' in ev) {
              // the mapper box is replaced by its inner iterator's run of boxes
              ops.push([`#${el} .box`, '-pending'], [`#${el}`, '+gone'], [`#fi${c.slot}`, '+shown']);
              boxState.delete(el);
            } else {
              ops.push([`#${el} .box`, '-pending +settled'], [`#${el} .sub`, '+reveal']);
              boxState.set(el, 'settled');
              setContent(el, 'sub', 'verdict' in ev ? String(ev.verdict) : display(ev.value));
            }
            break;
          }
          case 'result': {
            const r = index.results.get(ev.result);
            if (r.kind === 'return') {
              ops.push(['#c1 .box', '-pending +settled'], ['#c1 .val', '+reveal']);
              boxState.set('c1', 'settled');
              break;
            }
            const box = `r${r.row}`;
            const spec = 'error' in ev ? '-pending +settled +errored' : '-pending +settled';
            ops.push([`#${box} .box`, spec], [`#${box} .val`, '+reveal']);
            boxState.set(box, 'settled');
            setContent(box, 'val', valFor(ev));
            if (ev.from != null) {
              if (index.calls.has(ev.from)) {
                const c = index.calls.get(ev.from);
                arrows.push([`I${visualRow(c.slot)}`, `R${r.row}`]);
              } else {
                const p = index.pulls.get(ev.from);
                arrows.push(p.kind === 'inner' ? [`#m${p.row}${p.col}`, `R${r.row}`] : [`U${p.row}`, `R${r.row}`]);
              }
            }
            break;
          }
          case 'close': {
            // visible only once the teardown band is open; the source closes
            // in #c0, an inner iterator in #c2 (one inner close per animation)
            if (!bandOpen || ev.throws) break;
            let box;
            if (ev.target === 'source') box = 'c0';
            else {
              if (c2Inner != null && c2Inner !== ev.target) notAnimatable('only one inner close fits the band (#c2)');
              c2Inner = ev.target;
              box = 'c2';
            }
            ops.push([`#${box} .box`, '+pending']);
            boxState.set(box, 'pending');
            setContent(box, 'val', '{}');
            break;
          }
          case 'close-settled': {
            const box = ev.target === 'source' ? 'c0' : 'c2';
            if (boxState.get(box) !== 'pending') break; // its close was never shown
            stim.push({ box });
            const spec = 'error' in ev ? '-pending +settled +errored' : '-pending +settled';
            ops.push([`#${box} .box`, spec], [`#${box} .val`, '+reveal']);
            boxState.set(box, 'settled');
            if ('error' in ev) setContent(box, 'val', 'Error');
            break;
          }
          case 'open-closing': {
            if (!bandOpen) {
              ops.push(['#main', '+shifted'], ['#closing', '+shown']);
              bandOpen = true;
            }
            break;
          }
          case 'tombstone': {
            ops.push([ev.target === 'underlying' ? '#tomb-underlying' : '#tomb-result', '+reveal']);
            break;
          }
          case 'compact': {
            const slot = index.pulls.get(ev.pull).row;
            gone.add(slot);
            ops.push([`#i${slot}`, '+gone']);
            const lastEl = 3 + sparesSpawned;
            for (let idx = slot + 1; idx <= lastEl; idx++) {
              if (gone.has(idx)) continue;
              const newUp = [...gone].filter((g) => g < idx).length;
              const oldUp = upLevel.get(idx) ?? 0;
              if (newUp !== oldUp) {
                ops.push([`#i${idx}`, `${oldUp > 0 ? `-up${oldUp} ` : ''}+up${newUp}`]);
                upLevel.set(idx, newUp);
              }
            }
            if (sparesSpawned < 2) { // spawn the next parked spare (i4, then i5)
              const spare = 4 + sparesSpawned++;
              ops.push([`#i${spare}`, `+up${gone.size} +shown`]);
              upLevel.set(spare, gone.size);
            }
            break;
          }
          case 'void': {
            let box;
            if (ev.pull != null) box = pullBox(index.pulls.get(ev.pull));
            else if (ev.call != null) box = `i${index.calls.get(ev.call).slot}`;
            else box = `r${index.results.get(ev.result).row}`;
            ops.push([`#${box} .box`, boxState.get(box) === 'pending' ? '-pending +voided' : '+voided']);
            break;
          }
          case 'slot-error': {
            const slot = index.pulls.get(ev.pull).row;
            ops.push([`#i${slot} .box`, '+settled +errored'], [`#i${slot} .err`, '+reveal']);
            boxState.set(`i${slot}`, 'settled');
            setContent(`i${slot}`, 'err', 'Error');
            break;
          }
          case 'fn-sync':
            notAnimatable('fn-sync scenarios have no animation convention yet');
            break;
          case 'arm-throw':
            break; // no visual
          default:
            notAnimatable(`unhandled event type ${ev.type}`);
        }
      }

      const out = { caption: step.caption ?? tick.note ?? '', ops, aria: ariaFor(step.events) };
      const finalArrows = step.arrows ?? (arrows.length > 0 ? arrows : null);
      if (finalArrows) out.arrows = finalArrows;
      if (stim.length) out.dots = stim;
      steps.push(out);
    });
  });

  // Give every previewed stimulus its own beat: before each step that performs
  // one (i.e. carries `dots`), splice in a do-nothing step that just repeats the
  // prior visual state. Since the dot renders from the *next* step's `dots`, it
  // lands on this quiet beat — so "about to poke X" reads as its own step rather
  // than sharing the frame with the content that preceded it. The inserted step
  // borrows the preceding step's caption (nothing changed but the dot).
  const spaced = [];
  let previewSeen = false;
  for (const s of steps) {
    if (s.dots) {
      spaced.push({ caption: (spaced[spaced.length - 1] ?? s).caption, ops: [], aria: ariaForDots(s.dots, previewSeen) });
      previewSeen = true;
    }
    spaced.push(s);
  }

  const animation = { id: scenario.id, label: scenario.label, content, steps: spaced };
  // Base ops the player applies beneath every step (see render): hold the
  // teardown band open from the start for scenarios that never slide it in.
  if (startOpen) animation.baseOps = [['#main', '+shifted'], ['#closing', '+shown']];
  if (scenario.description != null) animation.description = scenario.description;
  return animation;
}

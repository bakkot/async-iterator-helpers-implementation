// Animations are authored as *scenarios* (semantic event sequences — see
// scenarios/FORMAT.md) and compiled to step timelines at load time. The
// same scenario files run as tests against the implementation repo.
import { scenarioToAnimation } from './scenarios/scenario-to-animation.js';
import { mapScenarios } from './scenarios/map-scenarios.js';
import { filterScenarios } from './scenarios/filter-scenarios.js';
import { flatMapScenarios } from './scenarios/flatmap-scenarios.js';
import { map } from '../map.js';
const root = document.getElementById('viz');

// The selectable sets of animations, switched via the `{map,filter,flatMap}`
// links in the header. `animations` always points at the active set.
const animationSets = {
  map: mapScenarios.map(scenarioToAnimation),
  filter: filterScenarios.map(scenarioToAnimation),
  flatMap: flatMapScenarios.map(scenarioToAnimation),
};
let animations = animationSets.map;

// every class the timeline can apply, so a render can wipe back to base
const STATE_CLASSES = ['pending', 'settled', 'voided', 'errored', 'reveal', 'gone', 'up1', 'up2', 'up3', 'shown', 'shifted'];
const RESET_SELECTOR = STATE_CLASSES.map(c => '.' + c).join(',');

let animIndex = 0;                              // which animation is selected
let step = 0;                                   // which step within it
let urlSync = false;                            // start writing the hash only after the first user switch
let currentSet = 'map';                         // active helper set (for the Interactive tab)
let interactive = false;                        // the live Interactive tab is active
const stepsOf = () => animations[animIndex].steps;
const maxStep = () => stepsOf().length - 1;

const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const stepnum = document.getElementById('stepnum');
const stepmax = document.getElementById('stepmax');
const caption = document.getElementById('caption');

// Populate the box text for an animation. `content` maps a box id to its
// text, keyed by text-class. `.label`/`.sub` (Internal column) are plain
// strings. `.val` (Underlying/Result) is a value-group whose contents we
// build: a bare string ("A"), or a record { done, value } shown as two
// lines. The steps still control *when* a box reveals (via .reveal).
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function recordLine(x, y, key, value, center) {
  const t = svgEl('text', { class: 'rline', x, y, 'dominant-baseline': 'central' });
  // a lone `done: …` line centers on x (size-independent, so it sits right in
  // the smaller flatMap boxes too); the two-line record stays left-aligned so
  // its `done:`/`value:` keys line up. Inline style beats the .rline CSS anchor.
  if (center) t.style.textAnchor = 'middle';
  const k = svgEl('tspan', { class: 'rk' }); k.textContent = key;
  const v = svgEl('tspan', { class: 'rv' }); v.textContent = value;
  t.append(k, v);
  return t;
}
function buildVal(group, val) {
  group.replaceChildren();
  // the bare-string "Error" sentinel reads at the smaller .err size (see CSS)
  group.classList.toggle('errval', val === 'Error');
  // mark the box exhausted when the record is `done: true` (drives the hatch)
  const box = group.parentNode && group.parentNode.querySelector('.box');
  if (box) box.classList.toggle('done', !!(val && typeof val === 'object' && val.done === 'true'));
  if (val == null) return;
  const cx = +group.dataset.cx, cy = +group.dataset.cy;
  if (typeof val === 'string') {
    const t = svgEl('text', { x: cx, y: cy, 'dominant-baseline': 'central' });
    t.textContent = val;
    group.appendChild(t);
  } else if (val.value == null) {
    // a record with no value (e.g. done: true) — single centered line
    group.appendChild(recordLine(cx, cy, 'done: ', val.done, true));
  } else {
    group.appendChild(recordLine(cx - 50, cy - 13, 'done: ',  val.done));
    group.appendChild(recordLine(cx - 50, cy + 13, 'value: ', val.value));
  }
}
function applyContent(content) {
  root.querySelectorAll('.label, .sub, .err').forEach(t => { t.textContent = ''; });
  root.querySelectorAll('.val').forEach(g => g.replaceChildren());
  root.querySelectorAll('.box.done').forEach(b => b.classList.remove('done'));
  for (const id in content) {
    const spec = content[id];
    for (const cls in spec) {
      if (cls === 'val') {
        const g = root.querySelector('#' + id + ' .val');
        if (g) buildVal(g, spec.val);
      } else {
        const el = root.querySelector('#' + id + ' .' + cls);
        if (el) el.textContent = spec[cls];
      }
    }
  }
}

// ---- arrows ----------------------------------------------------------
// A step's `arrows` are [from, to] cell pairs like ['U3','I2'] — a column
// letter + 0-based row. Cells live in one of two bands: the main diagram
// (U/I/R) and the closing teardown row (L = underlying.return(), M =
// inner.return() (flatMap only), P = result.return(), always row 1). We
// generate one <path> per distinct pair
// an animation uses, then just toggle .reveal to flash the current step's.
// Geometry is computed from the box rectangles: an arrow leaves the source
// box's near edge and arrives at the target's near edge, so it works in
// either direction — the close flows P→L, then resolves back L→P.
const mainArrows    = document.getElementById('arrows');         // rides the shift (inside #main)
const closingArrows = document.getElementById('closing-arrows'); // in the static top band
const BAND = { U: 'main', I: 'main', R: 'main', L: 'closing', M: 'closing', P: 'closing' };
const COLX = { U: 95, I: 385, R: 675, L: 95, M: 385, P: 675 };   // left edge of each column's box
const BOX_W = 130;
const CLOSING_CY = 105;                                   // single return-row center
// A cell is normally a column letter + row ("U3"); for flatMap's inner boxes
// it may instead be an element selector ("#m00"), whose geometry we read off
// the actual box rectangle so an arrow can leave one of those smaller boxes.
function cellGeom(cell) {
  if (cell[0] === '#') {
    const bb = root.querySelector(cell + ' .box').getBBox();
    return { left: bb.x, right: bb.x + bb.width, cy: bb.y + bb.height / 2 };
  }
  const x = COLX[cell[0]];
  return {
    left: x, right: x + BOX_W,
    cy: BAND[cell[0]] === 'closing' ? CLOSING_CY : 130 + (+cell.slice(1)) * 120,
  };
}
function arrowD([from, to]) {
  const a = cellGeom(from), b = cellGeom(to);
  const ltr = a.left < b.left;                       // left-to-right?
  const startX = ltr ? a.right + 2 : a.left - 2;     // leave the near edge (+2 into the gap)
  const endX   = ltr ? b.left - 2 : b.right + 2;     // arrive at the target's near edge
  return 'M ' + startX + ' ' + a.cy + ' L ' + endX + ' ' + b.cy;
}
let arrowEls = {};   // "from>to" -> <path>, rebuilt per animation
function buildArrows(anim) {
  mainArrows.textContent = '';
  closingArrows.textContent = '';
  arrowEls = {};
  for (const st of anim.steps) {
    for (const conn of (st.arrows || [])) {
      const key = conn[0] + '>' + conn[1];
      if (arrowEls[key]) continue;
      const p = svgEl('path', { class: 'arrow', d: arrowD(conn) });
      (BAND[conn[0][0]] === 'closing' ? closingArrows : mainArrows).appendChild(p);
      arrowEls[key] = p;
    }
  }
}

function applyStep(ops) {
  for (const [sel, spec] of ops) {
    const els = root.querySelectorAll(sel);
    for (const tok of spec.split(/\s+/)) {
      const add = tok[0] === '+';
      const cls = tok.slice(1);
      els.forEach(el => el.classList.toggle(cls, add));
    }
  }
}

// Rebuild the diagram for the current `step` by wiping to base and
// replaying every diff up to it. Because this all happens in one
// synchronous turn (no layout read), the browser only paints the final
// state — so a single-step move transitions just that step's delta.
// For jumps we add .no-anim and force one reflow so it snaps instead.
function render(animate) {
  if (!animate) root.classList.add('no-anim');

  // wipe ALL state classes (every element, regardless of animation), then
  // replay this animation's diffs up to the current step
  root.querySelectorAll(RESET_SELECTOR)
      .forEach(el => el.classList.remove(...STATE_CLASSES));
  const steps = stepsOf();
  for (let i = 1; i <= step; i++) applyStep(steps[i].ops);

  // Arrows are momentary: show only the connections this step declares.
  for (const key in arrowEls) arrowEls[key].classList.remove('reveal');
  for (const conn of (steps[step].arrows || [])) {
    const el = arrowEls[conn[0] + '>' + conn[1]];
    if (el) el.classList.add('reveal');
  }

  // grow the canvas while the closing band is in view; shrink back otherwise
  const shifted = document.getElementById('main').classList.contains('shifted');
  root.setAttribute('viewBox', shifted ? '0 0 900 740' : '0 0 900 560');

  if (!animate) {
    void root.getBoundingClientRect();   // commit the snap, then re-enable
    root.classList.remove('no-anim');
  }

  stepnum.textContent = step;
  stepmax.textContent = maxStep();
  caption.innerHTML = steps[step].caption;
  prevBtn.disabled = step === 0;
  nextBtn.disabled = step === maxStep();
}

function go(to) {
  to = Math.max(0, Math.min(maxStep(), to));
  const animate = Math.abs(to - step) === 1;   // single steps animate; jumps snap
  step = to;
  render(animate);
}

// ---- animation selector (tab buttons, generated from `animations`) ----
const tabsEl = document.getElementById('tabs');
const descEl = document.getElementById('description');
let descItems = [];   // one description <div> per animation, all stacked

// (Re)build the tabs + descriptions for the active set. Called once at
// startup and again whenever the header switches between map and filter.
function buildTabs() {
  tabsEl.replaceChildren();
  descEl.replaceChildren();
  descItems = [];
  animations.forEach((a, i) => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.textContent = a.label;
    b.addEventListener('click', () => selectAnimation(i));
    tabsEl.appendChild(b);

    // Render every description up front so the grid can size to the tallest.
    const d = document.createElement('div');
    d.innerHTML = a.description || '';
    descEl.appendChild(d);
    descItems.push(d);
  });

  // A live "Interactive" tab at the end of the set: instead of replaying a
  // pre-baked scenario, it drives the real implementation and reflects the
  // user's stimuli (see the interactive driver below). Distinguished with a
  // sparkle + shimmer so it reads as the odd one out.
  const ib = document.createElement('button');
  ib.className = 'tab interactive';
  ib.innerHTML = '✨ Interactive';
  ib.addEventListener('click', () => selectInteractive());
  tabsEl.appendChild(ib);
}

// Switch to a named set (map | filter), rebuild its tabs, and select one of
// its animations (the first by default). The header links reflect the set.
function selectSet(name, index = 0) {
  animations = animationSets[name];
  currentSet = name;
  root.classList.toggle('flatmap', name === 'flatMap');   // gates the inner.return() column
  setLinks.forEach((a, key) => a.classList.toggle('active', key === name));
  buildTabs();
  selectAnimation(index);
}

// Locate an animation by id across both sets (ids are unique across helpers,
// e.g. 'map-non-concurrent'). Returns { name, i } or null if unknown.
function locateAnim(id) {
  for (const name in animationSets) {
    const i = animationSets[name].findIndex(a => a.id === id);
    if (i !== -1) return { name, i };
  }
  return null;
}

const setLinks = new Map([
  ['map', document.getElementById('sel-map')],
  ['filter', document.getElementById('sel-filter')],
  ['flatMap', document.getElementById('sel-flatmap')],
]);
setLinks.forEach((a, name) => a.addEventListener('click', () => selectSet(name)));

function selectAnimation(i) {
  exitInteractive();   // leaving the live tab (if we were on it)
  animIndex = i;
  step = 0;
  [...tabsEl.children].forEach((b, j) => b.classList.toggle('active', j === i));
  descItems.forEach((d, j) => d.classList.toggle('active', j === i));
  buildArrows(animations[i]);                  // generate this animation's arrow paths
  applyContent(animations[i].content || {});   // load this animation's box text
  render(false);   // render() wipes any state left from the prior animation
  // Reflect the selection in the URL, in place (no new history entry, and
  // replaceState doesn't scroll or fire hashchange). Suppressed for the
  // initial paint so a fresh load doesn't immediately stamp the hash — we
  // only start syncing once the user actually switches.
  if (urlSync) history.replaceState(null, '', '#' + animations[i].id);
}

// ====================================================================
// Interactive (live) mode
// --------------------------------------------------------------------
// Instead of replaying a recorded scenario, the Interactive tab wires up
// the *real* implementation (imported above) behind a controlled source
// and controlled fn, and lets the user supply the stimuli the recorded
// scenarios bake in: calling `.next()`/`.return()`, and settling the
// promises the helper is waiting on (the underlying pulls, the mapper
// calls, the underlying `.return()`).
//
// Each user action is one *tick*: we perform the stimulus, drain the
// microtask queue so the implementation reacts fully, then commit every
// resulting effect in a single synchronous DOM pass — so same-tick
// effects animate simultaneously (different ticks come from different
// user actions, which are naturally sequenced). Input is refused while a
// tick's transition plays out.
//
// The diagram grid is fixed (rows 0..3), and `map` keeps a strict
// one-to-one correspondence: the k-th `.next()` drives pull/​slot/​result
// row k. We tag source values with letters (A,B,…) and mapper results
// with `f`-prefixes (fA,…) so the data flowing through the real helper
// also tells us which boxes to light and which arrows to draw.
// ====================================================================
const LETTERS = ['A', 'B', 'C', 'D'];
const flush = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await Promise.resolve(); };

// Resolve once every CSS transition kicked off by the just-committed frame
// has finished — so input is gated for exactly as long as the effects take
// to play out (and not at all when nothing actually moved). We count
// transitionrun against transitionend/cancel on the SVG (the events bubble);
// if nothing has begun within a couple of frames there was nothing to wait
// for. If the count never returns to zero, that's a bug (an unbalanced or
// never-ending transition) — make it loud rather than silently recovering.
function waitForTransitions() {
  return new Promise((resolve) => {
    let running = 0, started = false, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.removeEventListener('transitionrun', onRun);
      root.removeEventListener('transitionend', onEnd);
      root.removeEventListener('transitioncancel', onEnd);
      clearTimeout(stuck);
      resolve();
    };
    const onRun = () => { running++; started = true; };
    const onEnd = () => { if (started && --running <= 0) finish(); };
    root.addEventListener('transitionrun', onRun);
    root.addEventListener('transitionend', onEnd);
    root.addEventListener('transitioncancel', onEnd);
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!started) finish(); }));
    const stuck = setTimeout(() => {
      if (done) return;
      alert(`Interactive demo is stuck: ${running} transition(s) never finished after 4s. ` +
        `This is a bug in the effect playout — check waitForTransitions/commitFrame.`);
    }, 4000);
  });
}

let ix = null;                // the live session ({ mapped, results, ... }) or null
const stimuli = new Map();    // boxId -> { kind, deferred, row?, slot?, arg? } for settleable promises

// Per-tick frame: every effect is recorded here during the microtask
// drain, then flushed to the DOM together by commitFrame().
let fOps, fContent, fArrows, fDotAdd, fDotRemove;
function resetFrame() { fOps = []; fContent = []; fArrows = []; fDotAdd = []; fDotRemove = []; }

// ---- recorders (called as the helper reacts; pure data, no DOM) ----
function recResultPending(row) { fOps.push([`#r${row} .box`, '+pending']); }
function recPullPending(row, d) {
  fOps.push([`#u${row} .box`, '+pending']);
  fDotAdd.push({ id: `u${row}`, st: { kind: 'pull', deferred: d, row } });
}
function recFnPending(slot, arg, d) {
  fOps.push([`#i${slot} .box`, '+pending'], [`#i${slot} .label`, '+reveal'], [`#i${slot} .divider`, '+reveal']);
  fContent.push([`i${slot}`, 'label', `f(${arg})`]);
  fArrows.push([`U${slot}`, `I${slot}`]);
  fDotAdd.push({ id: `i${slot}`, st: { kind: 'fn', deferred: d, slot, arg } });
}
function recClosePending(d) {
  fOps.push(['#c0 .box', '+pending']);
  fContent.push(['c0', 'val', '{}']);
  fDotAdd.push({ id: 'c0', st: { kind: 'return', deferred: d } });
}
function recReturnPending() {
  fOps.push(['#c1 .box', '+pending']);
  fContent.push(['c1', 'val', '{}']);
}
function recPullSettle(row, kind) {           // kind: 'value' | 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push([`#u${row} .box`, spec], [`#u${row} .val`, '+reveal']);
  fContent.push([`u${row}`, 'val', kind === 'value' ? LETTERS[row] : kind === 'done' ? { done: 'true' } : 'Error']);
  fDotRemove.push(`u${row}`);
}
function recFnSettleValue(slot, mapped) {
  fOps.push([`#i${slot} .box`, '-pending +settled'], [`#i${slot} .sub`, '+reveal']);
  fContent.push([`i${slot}`, 'sub', mapped]);
  fDotRemove.push(`i${slot}`);
}
function recFnSettleError(slot) {
  fOps.push([`#i${slot} .box`, '-pending +settled +errored'], [`#i${slot} .label`, '-reveal'],
    [`#i${slot} .divider`, '-reveal'], [`#i${slot} .err`, '+reveal']);
  fContent.push([`i${slot}`, 'err', 'Error']);
  fDotRemove.push(`i${slot}`);
}
function recResultSettle(row, kind, value) {  // kind: 'value' | 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push([`#r${row} .box`, spec], [`#r${row} .val`, '+reveal']);
  fContent.push([`r${row}`, 'val', kind === 'value' ? value : kind === 'done' ? { done: 'true' } : 'Error']);
  if (kind === 'value') {
    const slot = ix.mappedToSlot.get(value);
    if (slot != null) fArrows.push([`I${slot}`, `R${row}`]);
  }
}
function recCloseSettle(kind) {               // c0 (underlying .return()): 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push(['#c0 .box', spec], ['#c0 .val', '+reveal']);
  if (kind === 'error') fContent.push(['c0', 'val', 'Error']);
  fDotRemove.push('c0');
}
function recReturnSettle(kind) {              // c1 (result .return()): 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push(['#c1 .box', spec], ['#c1 .val', '+reveal']);
  if (kind === 'error') fContent.push(['c1', 'val', 'Error']);
}

// ---- controlled source + fn that record as the helper drives them ----
function makeSession() {
  const sourceIterator = {
    next() {
      const row = ix.pullCount++;
      const d = Promise.withResolvers();
      recPullPending(row, d);
      return d.promise;
    },
    return() {
      const d = Promise.withResolvers();
      recClosePending(d);
      return d.promise;
    },
    [Symbol.asyncIterator]() { return this; },
  };
  const fn = (value) => {
    const slot = LETTERS.indexOf(value);    // value is the source letter -> its row
    const d = Promise.withResolvers();
    recFnPending(slot, value, d);
    return d.promise;
  };
  ix = {
    mapped: map(sourceIterator, fn),
    results: [],                 // one per consumer .next(), in call order
    mappedToSlot: new Map(),     // mapper result value -> Internal slot (for I->R arrows)
    pullCount: 0,
    busy: false,
  };
}

// ---- the three user-action entry points ----
function doNext() {
  const row = ix.results.length;
  recResultPending(row);
  const p = ix.mapped.next();   // synchronously issues the underlying pull (recorded above)
  ix.results.push(p);
  p.then(
    (v) => recResultSettle(row, v.done ? 'done' : 'value', v.value),
    () => recResultSettle(row, 'error'),
  );
}
function doReturn() {
  recReturnPending();
  ix.mapped.return().then(() => recReturnSettle('done'), () => recReturnSettle('error'));
}
function settleStimulus(id, type) {           // type: 'value' | 'done' | 'error'
  const st = stimuli.get(id);
  if (!st) return;
  if (st.kind === 'pull') {
    recPullSettle(st.row, type);
    if (type === 'value') st.deferred.resolve({ value: LETTERS[st.row], done: false });
    else if (type === 'done') st.deferred.resolve({ value: undefined, done: true });
    else st.deferred.reject(new Error('boom'));
  } else if (st.kind === 'fn') {
    if (type === 'done') return;              // mapper result: right-click does nothing
    if (type === 'value') {
      const mapped = 'f' + st.arg;
      ix.mappedToSlot.set(mapped, st.slot);
      recFnSettleValue(st.slot, mapped);
      st.deferred.resolve(mapped);
    } else {
      recFnSettleError(st.slot);
      st.deferred.reject(new Error('boom'));
    }
  } else {                                    // kind 'return' — underlying .return()
    if (type === 'error') { recCloseSettle('error'); st.deferred.reject(new Error('boom')); }
    else { recCloseSettle('done'); st.deferred.resolve({ value: undefined, done: true }); }
  }
}

// Run one user action as a single tick: perform it, let the helper react
// to quiescence, then commit every effect at once. Input is refused for
// the duration of the resulting transition.
async function userAction(perform) {
  if (!ix || ix.busy) return;
  ix.busy = true;
  updateButtons();
  resetFrame();
  perform();
  await flush();
  commitFrame();
  updateButtons();
  await waitForTransitions();   // gate input for exactly the effects' duration
  if (ix) { ix.busy = false; updateButtons(); }
}

function commitFrame() {
  applyStep(fOps);
  for (const [id, field, val] of fContent) {
    if (field === 'val') buildVal(root.querySelector(`#${id} .val`), val);
    else { const el = root.querySelector(`#${id} .${field}`); if (el) el.textContent = val; }
  }
  for (const id of fDotRemove) removeDot(id);
  for (const d of fDotAdd) addDot(d);
  for (const key in arrowEls) arrowEls[key].classList.remove('reveal');   // arrows are momentary
  for (const conn of fArrows) revealArrow(conn);
}

// ---- stimulus dots ----
function addDot({ id, st }) {
  stimuli.set(id, st);
  const box = root.querySelector(`#${id} .box`);
  box.classList.add('stimulus');
  const dot = svgEl('circle', {
    class: 'stim-dot',
    cx: +box.getAttribute('x') + 15,
    cy: +box.getAttribute('y') + 15,
    r: 7,
  });
  root.querySelector(`#${id}`).appendChild(dot);
}
function removeDot(id) {
  stimuli.delete(id);
  root.querySelector(`#${id} .box`)?.classList.remove('stimulus');
  root.querySelector(`#${id} .stim-dot`)?.remove();
}

function revealArrow(conn) {
  const key = conn[0] + '>' + conn[1];
  let el = arrowEls[key];
  if (!el) {
    el = svgEl('path', { class: 'arrow', d: arrowD(conn) });
    (BAND[conn[0][0]] === 'closing' ? closingArrows : mainArrows).appendChild(el);
    arrowEls[key] = el;
  }
  el.classList.add('reveal');
}

// Delegated pointer handling: a left/shift click or right-click on a box
// that currently carries a settleable promise drives that settlement.
root.addEventListener('click', (e) => {
  if (!interactive || !ix || ix.busy) return;
  const g = e.target.closest('[id]');
  if (g && stimuli.has(g.id)) userAction(() => settleStimulus(g.id, e.shiftKey ? 'error' : 'value'));
});
root.addEventListener('contextmenu', (e) => {
  if (!interactive || !ix) return;
  const g = e.target.closest('[id]');
  const st = g && stimuli.get(g.id);
  if (!st) return;
  e.preventDefault();                       // suppress the context menu over any settleable box
  if (st.kind === 'fn') return;             // right-click does nothing on a mapper result
  if (!ix.busy) userAction(() => settleStimulus(g.id, 'done'));
});

// ---- enabling/disabling the consumer buttons ----
function updateButtons() {
  const nb = root.querySelector('#next-btn');
  const rb = root.querySelector('#return-btn');
  if (nb) nb.classList.toggle('disabled', !ix || ix.busy || ix.results.length >= 4);
  if (rb) rb.classList.toggle('disabled', !ix || ix.busy);
}

// ---- building the consumer controls (.next() + result.return()) ----
function buildInteractiveButtons() {
  root.querySelector('#next-btn')?.remove();
  // A `.next()` button sits just under the Result column header.
  const g = svgEl('g', { id: 'next-btn', class: 'ibtn' });
  const bg = svgEl('rect', { class: 'ibtn-bg', x: 683, y: 58, width: 114, height: 26, rx: 7 });
  const label = svgEl('text', { class: 'ibtn-label', x: 740, y: 71, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  label.textContent = '.next()';
  g.append(bg, label);
  document.getElementById('main').appendChild(g);
  g.addEventListener('click', () => { if (ix && !ix.busy && ix.results.length < 4) userAction(doNext); });

  // Turn the result.return() column header into a button: wrap the existing
  // header text in a clickable group behind a backing pill (so the whole pill
  // is the hit target). exitInteractive() unwraps it back to a plain header.
  const hdr = [...root.querySelectorAll('#closing .header.ret')].find(t => t.textContent.includes('result.return'));
  if (hdr && !root.querySelector('#return-btn')) {
    const bb = hdr.getBBox();
    const grp = svgEl('g', { id: 'return-btn', class: 'ibtn' });
    const pill = svgEl('rect', { class: 'ibtn-header-bg', x: bb.x - 12, y: bb.y - 5, width: bb.width + 24, height: bb.height + 10, rx: 8 });
    hdr.parentNode.insertBefore(grp, hdr);
    grp.append(pill, hdr);                 // pill behind, header text in front
    hdr.classList.add('ibtn-header');
    grp.addEventListener('click', () => { if (ix && !ix.busy) userAction(doReturn); });
  }
}

const IX_INSTRUCTIONS = 'This drives the <i>real</i> <code>map</code> implementation — your clicks are the stimuli, and the boxes show what it actually does in response. Press <code>.next()</code> (or <code>result.return()</code>) to act as the consumer. Any promise the helper is waiting on wears a glowing dot — settle it yourself: <b>click</b> = a value, <b>right-click</b> = <code>done</code>, <b>shift-click</b> = an error. Effects from one tick animate together; input is paused while they play out.';
const IX_COMING_SOON = (h) => `Interactive mode for <code>${h}</code> is coming soon — only <code>map</code> is wired up so far.`;

function selectInteractive() {
  exitInteractive();
  interactive = true;
  [...tabsEl.children].forEach((b) => b.classList.remove('active'));
  tabsEl.querySelector('.tab.interactive')?.classList.add('active');

  // Wipe to a clean diagram with the closing band permanently open and the
  // box columns lowered (the `interactive` class drives both, via CSS).
  root.classList.add('no-anim', 'interactive');
  root.querySelectorAll(RESET_SELECTOR).forEach((el) => el.classList.remove(...STATE_CLASSES));
  applyContent({});
  mainArrows.textContent = ''; closingArrows.textContent = ''; arrowEls = {};
  document.getElementById('main').classList.add('shifted');
  document.getElementById('closing').classList.add('shown');
  root.setAttribute('viewBox', '0 0 900 760');
  root.querySelectorAll('.stim-dot').forEach((d) => d.remove());
  stimuli.clear();
  buildInteractiveButtons();
  void root.getBoundingClientRect();
  root.classList.remove('no-anim');

  // Hide the stepper (the live tab is click-driven) and show the usage
  // instructions in the top description area rather than the bottom note.
  document.querySelector('.controls').style.display = 'none';
  document.querySelector('.hint').style.display = 'none';
  caption.innerHTML = '';
  descItems.forEach((d) => d.classList.remove('active'));
  let ixDesc = descEl.querySelector('#ix-desc');
  if (!ixDesc) { ixDesc = document.createElement('div'); ixDesc.id = 'ix-desc'; descEl.appendChild(ixDesc); }
  ixDesc.innerHTML = currentSet === 'map' ? IX_INSTRUCTIONS : IX_COMING_SOON(currentSet);
  ixDesc.classList.add('active');

  if (currentSet === 'map') makeSession();
  else ix = null;
  updateButtons();

  if (urlSync) history.replaceState(null, '', '#' + currentSet + '-interactive');
}

function exitInteractive() {
  if (!interactive) return;
  interactive = false;
  ix = null;
  stimuli.clear();
  root.classList.remove('interactive');
  descEl.querySelector('#ix-desc')?.remove();
  root.querySelectorAll('.stim-dot').forEach((d) => d.remove());
  root.querySelectorAll('.box.stimulus').forEach((b) => b.classList.remove('stimulus'));
  root.querySelector('#next-btn')?.remove();
  const grp = root.querySelector('#return-btn');   // unwrap the result.return() button
  if (grp) {
    const txt = grp.querySelector('.header.ret');
    txt.classList.remove('ibtn-header');
    grp.parentNode.insertBefore(txt, grp);
    grp.remove();
  }
  document.querySelector('.controls').style.display = '';
  document.querySelector('.hint').style.display = '';
}

nextBtn.addEventListener('click', () => go(step + 1));
prevBtn.addEventListener('click', () => go(step - 1));

window.addEventListener('keydown', (e) => {
  if (interactive) return;   // the stepper is inert on the live tab
  if (e.altKey) {
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown':
        e.preventDefault();
        selectAnimation((animIndex + 1) % animations.length);
        return;
      case 'ArrowLeft': case 'ArrowUp':
        e.preventDefault();
        selectAnimation((animIndex - 1 + animations.length) % animations.length);
        return;
    }
    return;
  }
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown': case 'j':
      e.preventDefault(); go(step + 1); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'k':
      e.preventDefault(); go(step - 1); break;
    case 'Home': e.preventDefault(); go(0); break;
    case 'End':  e.preventDefault(); go(maxStep()); break;
  }
});

// Park each tombstone just past the right edge of its (centered) header,
// measured once now that the SVG is laid out.
function placeTombstone(tombId, headerId) {
  const tomb = document.getElementById(tombId);
  const header = document.getElementById(headerId);
  if (!tomb || !header) return;
  const bb = header.getBBox();
  tomb.setAttribute('x', bb.x + bb.width + 6);
}
placeTombstone('tomb-underlying', 'hdr-underlying');
placeTombstone('tomb-result', 'hdr-result');

// Initial paint: jump to the animation named in the URL hash if it's a known
// id, otherwise fall back to the map set's first animation. A `#<set>-interactive`
// hash lands on that set's live tab.
const hash = decodeURIComponent((location.hash || '').slice(1));
if (hash.endsWith('-interactive') && animationSets[hash.slice(0, -'-interactive'.length)]) {
  selectSet(hash.slice(0, -'-interactive'.length));
  selectInteractive();
} else {
  const initial = locateAnim(hash);
  if (initial) selectSet(initial.name, initial.i);
  else selectSet('map');
}
urlSync = true;   // from here on, switches update the hash

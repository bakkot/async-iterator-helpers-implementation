// Animations are authored as *scenarios* (semantic event sequences — see
// scenarios/FORMAT.md) and compiled to step timelines at load time. The
// same scenario files run as tests against the implementation repo.
import { scenarioToAnimation } from './scenarios/scenario-to-animation.js';
import { mapScenarios } from './scenarios/map-scenarios.js';
import { filterScenarios } from './scenarios/filter-scenarios.js';
import { flatMapScenarios } from './scenarios/flatmap-scenarios.js';
import { map } from '../map.js';
import { filter } from '../filter.js';
import { flatMap } from '../flatMap.ts';
const root = document.getElementById('viz');

// The selectable sets of animations, switched via the `{map,filter,flatMap}`
// links in the header. `animations` always points at the active set.
const animationSets = {
  map: mapScenarios.map(scenarioToAnimation),
  filter: filterScenarios.map(scenarioToAnimation),
  flatMap: flatMapScenarios.map(scenarioToAnimation),
};
let animations = animationSets.map;

// every class the timeline can apply, so a render can wipe back to base.
// upN classes past up3 are minted on demand (ensureUpClass) when the live
// tab compacts past the static rows; they join this list as they're made.
const STATE_CLASSES = ['pending', 'settled', 'voided', 'errored', 'reveal', 'gone', 'up1', 'up2', 'up3', 'shown', 'shifted'];
let RESET_SELECTOR = STATE_CLASSES.map(c => '.' + c).join(',');

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
// The same driver backs all three helpers; the per-helper differences are
// confined to `HELPERS` (the Internal label and what settling the `fn`
// promise means) and a few branches in settleStimulus. We tag the k-th
// underlying value with letterFor(k) (A..Z, then AA, AB, …; so a pull's box and any
// predicate/mapper it feeds are identified by that row), `map` mapper
// results with an `f`-prefix (fA,…), and `flatMap` inner values with the
// lowercased source letter + column (a0, a1, …). That tagging lets the
// data flowing through the real helper tell us which boxes to light and
// which arrows to draw.
//
// Unlike `map`'s strict one-to-one, `filter` can *drop* a value (predicate
// false): the Internal slot compacts away and the helper issues a fresh
// underlying pull — exactly as the recorded scenarios show. `flatMap`
// replaces a settled mapper box with the inner iterator it returned (a run
// of smaller pull boxes) and flattens those. The visual bookkeeping for
// compaction (gone slots / climbing rows / spare slots) mirrors
// scenario-to-animation.js.
// ====================================================================
// Underlying values are spreadsheet-style letters: A..Z, then AA, AB, …
function letterFor(n) {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function letterIndex(s) {
  let n = 0;
  for (const c of s) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}
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

// Per-helper config: the Internal-box label prefix, the real constructor,
// and whether the Internal box draws a label/value divider (flatMap's box is
// replaced by an inner-iterator run, so it has no sub-value line).
const HELPERS = {
  map:     { fnDisplay: 'f',    make: map,     divider: true },
  filter:  { fnDisplay: 'pred', make: filter,  divider: true },
  flatMap: { fnDisplay: 'f',    make: flatMap, divider: false },
};

let ix = null;                // the live session, or null
const stimuli = new Map();    // boxId -> { kind, deferred, row?, slot?, col?, arg? } for settleable promises

// Visual bookkeeping carried across ticks (compaction, mirroring
// scenario-to-animation.js). Reset per session. `map`/`flatMap` never
// compact, so for them `gone` stays empty and visualRow is the identity.
// `maxSlot` is the highest Internal slot materialized so far (the static
// markup provides 0..5; ensureSlot mints more as the session needs them).
let vstate;
function resetVState() { vstate = { gone: new Set(), upLevel: new Map(), maxSlot: 3 }; }
const visualRow = (slot) => { let n = slot; for (const g of vstate.gone) if (g < slot) n--; return n; };

// Per-tick frame: every effect is recorded here during the microtask
// drain, then flushed to the DOM together by commitFrame().
let fOps, fContent, fArrows, fDotAdd, fDotRemove;
function resetFrame() { fOps = []; fContent = []; fArrows = []; fDotAdd = []; fDotRemove = []; }

// ---- dynamic geometry --------------------------------------------------
// The static markup bakes in four rows per column (and four inner-iterator
// columns per flatMap row); the live tab materializes more as the user
// drives past them. Everything minted here is tagged .dyn and torn down by
// exitInteractive. New elements are created during the microtask drain —
// nothing paints until the tick's commit, so they appear with that frame.

// .upN transform rules exist in the stylesheet for N <= 3; mint the rest.
const dynStyle = document.head.appendChild(document.createElement('style'));
let maxUpRule = 3;
function ensureUpClass(n) {
  while (maxUpRule < n) {
    maxUpRule++;
    dynStyle.sheet.insertRule(`.up${maxUpRule} { transform: translateY(-${maxUpRule * 120}px); }`);
    STATE_CLASSES.push(`up${maxUpRule}`);
    RESET_SELECTOR = STATE_CLASSES.map(c => '.' + c).join(',');
  }
}

// Grow the canvas to fit `rows` grid rows (closing band + shifted main +
// the interactive 20px button clearance + a 25px bottom margin).
function growViewBox(rows) {
  if (rows <= ix.vRows) return;
  ix.vRows = rows;
  root.setAttribute('viewBox', `0 0 900 ${400 + (rows - 1) * 120}`);
}

function makeValCol(id, x, row) {   // an Underlying/Result-style box group
  const g = svgEl('g', { id, class: 'dyn' });
  g.appendChild(svgEl('rect', { class: 'box', x, y: 85 + row * 120, width: 130, height: 90, rx: 8 }));
  g.appendChild(svgEl('g', { class: 'val', 'data-cx': x + 65, 'data-cy': 130 + row * 120 }));
  document.getElementById('main').appendChild(g);
}
function ensureURow(row) {
  if (!root.querySelector(`#u${row}`)) makeValCol(`u${row}`, 95, row);
  growViewBox(row + 1);
}
function ensureRRow(row) {
  if (!root.querySelector(`#r${row}`)) makeValCol(`r${row}`, 675, row);
  growViewBox(row + 1);
}
// Materialize Internal slots up to `slot`. Like the static spares, each
// parks at its own base row and is shown climbed to the stack's current
// bottom (its base row minus one per compacted slot above it).
function ensureSlot(slot) {
  while (vstate.maxSlot < slot) {
    const s = ++vstate.maxSlot;
    if (!root.querySelector(`#i${s}`)) {
      const y = 85 + s * 120;
      const g = svgEl('g', { id: `i${s}`, class: 'spare dyn' });
      g.appendChild(svgEl('rect', { class: 'box', x: 385, y, width: 130, height: 90, rx: 8 }));
      g.appendChild(svgEl('text', { class: 'label', x: 450, y: y + 28, 'dominant-baseline': 'central' }));
      g.appendChild(svgEl('line', { class: 'divider', x1: 397, y1: y + 46, x2: 503, y2: y + 46 }));
      g.appendChild(svgEl('text', { class: 'sub', x: 450, y: y + 70, 'dominant-baseline': 'central' }));
      g.appendChild(svgEl('text', { class: 'err', x: 450, y: y + 45, 'dominant-baseline': 'central' }));
      document.getElementById('main').appendChild(g);
    }
    const up = vstate.gone.size;
    ensureUpClass(up);
    fOps.push([`#i${s}`, `${up > 0 ? `+up${up} ` : ''}+shown`]);
    vstate.upLevel.set(s, up);
    growViewBox(s - up + 1);
  }
}
// flatMap inner rows: four columns fit at the native box size; a fifth and
// beyond squeeze the whole run into the same horizontal span.
const FI_LEFT = 261, FI_RIGHT = 639, FI_GAP = 14;
function fmBox(slot, col) {
  const m = svgEl('g', { id: `m${slot}${col}`, class: 'fmbox' });
  m.appendChild(svgEl('rect', { class: 'box', y: 101 + slot * 120, height: 58, rx: 6 }));
  m.appendChild(svgEl('g', { class: 'val', 'data-cy': 130 + slot * 120 }));
  return m;
}
function layoutInnerRow(slot, cols) {
  const w = (FI_RIGHT - FI_LEFT - FI_GAP * (cols - 1)) / cols;
  for (let col = 0; col < cols; col++) {
    const m = root.querySelector(`#m${slot}${col}`);
    if (!m) continue;
    const x = FI_LEFT + col * (w + FI_GAP), cx = x + w / 2;
    const box = m.querySelector('.box');
    box.setAttribute('x', x);
    box.setAttribute('width', w);
    const val = m.querySelector('.val');
    val.dataset.cx = cx;
    // inner-box values are always a single centered line, so re-centering
    // the existing text is a plain x move
    val.querySelectorAll('text').forEach((t) => t.setAttribute('x', cx));
    m.querySelector('.stim-dot')?.setAttribute('cx', x + Math.min(15, w / 2));
  }
}
function ensureFiRow(slot) {
  if (root.querySelector(`#fi${slot}`)) return;
  const g = svgEl('g', { id: `fi${slot}`, class: 'spare dyn' });
  for (let col = 0; col < 4; col++) g.appendChild(fmBox(slot, col));
  document.getElementById('main').appendChild(g);
  layoutInnerRow(slot, 4);
  growViewBox(slot + 1);
}
function ensureInnerBox(slot, col) {   // inner pulls arrive in column order
  if (root.querySelector(`#m${slot}${col}`)) return;
  const m = fmBox(slot, col);
  m.classList.add('dyn');
  root.querySelector(`#fi${slot}`).appendChild(m);
  layoutInnerRow(slot, col + 1);
}

// ---- recorders (called as the helper reacts; they record class/content
// effects for the commit, materializing any rows/boxes they target) ----
function recResultPending(row) {
  ensureRRow(row);
  fOps.push([`#r${row} .box`, '+pending']);
}
function recPullPending(row, d) {
  ensureURow(row);
  fOps.push([`#u${row} .box`, '+pending']);
  fDotAdd.push({ id: `u${row}`, st: { kind: 'pull', deferred: d, row } });
}
function recFnPending(slot, arg, d) {
  ensureSlot(slot);
  fOps.push([`#i${slot} .box`, '+pending'], [`#i${slot} .label`, '+reveal']);
  if (HELPERS[ix.helper].divider) fOps.push([`#i${slot} .divider`, '+reveal']);
  fContent.push([`i${slot}`, 'label', `${HELPERS[ix.helper].fnDisplay}(${arg})`]);
  fArrows.push([`U${slot}`, `I${visualRow(slot)}`]);
  fDotAdd.push({ id: `i${slot}`, st: { kind: 'fn', deferred: d, slot, arg } });
}
function recInnerPullPending(slot, col, d) {   // flatMap inner-iterator pull
  ensureInnerBox(slot, col);
  fOps.push([`#m${slot}${col} .box`, '+pending']);
  fDotAdd.push({ id: `m${slot}${col}`, st: { kind: 'inner', deferred: d, slot, col } });
}
function recClosePending(box, kind, d) {       // box: 'c0' (underlying) | 'c2' (inner)
  fOps.push([`#${box} .box`, '+pending']);
  fContent.push([box, 'val', '{}']);
  fDotAdd.push({ id: box, st: { kind, deferred: d } });
}
function recReturnPending() {                  // c1: the consumer's own result.return()
  fOps.push(['#c1 .box', '+pending']);
  fContent.push(['c1', 'val', '{}']);
}
function recPullSettle(row, kind) {           // kind: 'value' | 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push([`#u${row} .box`, spec], [`#u${row} .val`, '+reveal']);
  fContent.push([`u${row}`, 'val', kind === 'value' ? letterFor(row) : kind === 'done' ? { done: 'true' } : 'Error']);
  fDotRemove.push(`u${row}`);
}
function recInnerSettle(slot, col, kind, token) {
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push([`#m${slot}${col} .box`, spec], [`#m${slot}${col} .val`, '+reveal']);
  fContent.push([`m${slot}${col}`, 'val', kind === 'value' ? token : kind === 'done' ? { done: 'true' } : 'Error']);
  fDotRemove.push(`m${slot}${col}`);
}
function recFnSettleValue(slot, sub) {        // map: mapped value; filter: 'true'
  fOps.push([`#i${slot} .box`, '-pending +settled'], [`#i${slot} .sub`, '+reveal']);
  fContent.push([`i${slot}`, 'sub', sub]);
  fDotRemove.push(`i${slot}`);
}
function recFnSettleIterator(slot) {          // flatMap: box becomes the inner run
  ensureFiRow(slot);
  fOps.push([`#i${slot} .box`, '-pending'], [`#i${slot}`, '+gone'], [`#fi${slot}`, '+shown']);
  fDotRemove.push(`i${slot}`);
}
function recFnSettleError(slot) {
  fOps.push([`#i${slot} .box`, '-pending +settled +errored'], [`#i${slot} .label`, '-reveal'],
    [`#i${slot} .divider`, '-reveal'], [`#i${slot} .err`, '+reveal']);
  fContent.push([`i${slot}`, 'err', 'Error']);
  fDotRemove.push(`i${slot}`);
}
// A filter drop (predicate false) or exhaustion-discard: the Internal slot
// fades out, later slots climb, and a parked spare spawns into the freed
// bottom row — exactly the compaction the recorded scenarios animate.
function recCompact(slot) {
  vstate.gone.add(slot);
  fOps.push([`#i${slot}`, '+gone']);
  fDotRemove.push(`i${slot}`);
  for (let idx = slot + 1; idx <= vstate.maxSlot; idx++) {
    if (vstate.gone.has(idx)) continue;
    const newUp = [...vstate.gone].filter((g) => g < idx).length;
    const oldUp = vstate.upLevel.get(idx) ?? 0;
    if (newUp !== oldUp) {
      ensureUpClass(newUp);
      fOps.push([`#i${idx}`, `${oldUp > 0 ? `-up${oldUp} ` : ''}+up${newUp}`]);
      vstate.upLevel.set(idx, newUp);
    }
  }
  ensureSlot(vstate.maxSlot + 1);   // spawn a fresh spare into the freed bottom row
}
function recResultSettle(row, kind, value) {  // kind: 'value' | 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push([`#r${row} .box`, spec], [`#r${row} .val`, '+reveal']);
  fContent.push([`r${row}`, 'val', kind === 'value' ? value : kind === 'done' ? { done: 'true' } : 'Error']);
  if (kind === 'value') {
    const from = deliveryArrowFrom(value);
    if (from) fArrows.push([from, `R${row}`]);
  }
}
// The cell a delivered value flowed from, for the Internal/inner -> Result
// arrow: a predicate/mapper slot (map, filter) or an inner pull box (flatMap).
function deliveryArrowFrom(value) {
  if (ix.helper === 'flatMap') {
    const cell = ix.innerValueToCell.get(value);
    return cell ? `#m${cell.slot}${cell.col}` : null;
  }
  const slot = ix.valueToSlot.get(value);
  return slot != null ? `I${visualRow(slot)}` : null;
}
function recCloseSettle(box, kind) {          // c0 / c2: 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push([`#${box} .box`, spec], [`#${box} .val`, '+reveal']);
  if (kind === 'error') fContent.push([box, 'val', 'Error']);
  fDotRemove.push(box);
}
function recReturnSettle(kind) {              // c1 (result .return()): 'done' | 'error'
  const spec = kind === 'error' ? '-pending +settled +errored' : '-pending +settled';
  fOps.push(['#c1 .box', spec], ['#c1 .val', '+reveal']);
  if (kind === 'error') fContent.push(['c1', 'val', 'Error']);
}

// ---- controlled source / fn / inner iterators that record as the helper
// drives them. The user settles every promise these hand out. ----
function makeSession(helper) {
  resetVState();
  ix = {
    helper,
    obj: null,
    results: [],                  // one per consumer .next(), in call order
    pullCount: 0,                 // underlying rows handed out (u0, u1, …)
    valueToSlot: new Map(),       // map: mapped value, filter: source value -> Internal slot
    innerValueToCell: new Map(),  // flatMap: inner token -> { slot, col }
    inners: new Map(),            // flatMap: Internal slot -> { pullCount }
    vRows: 4,                     // grid rows the viewBox currently fits
    busy: false,
  };
  const source = {
    next() {
      const row = ix.pullCount++;
      const d = Promise.withResolvers();
      recPullPending(row, d);
      return d.promise;
    },
    return() {
      const d = Promise.withResolvers();
      recClosePending('c0', 'return', d);
      return d.promise;
    },
    [Symbol.asyncIterator]() { return this; },
  };
  const fn = (value) => {
    const slot = letterIndex(value);        // value is the source letter -> its row
    const d = Promise.withResolvers();
    recFnPending(slot, value, d);
    return d.promise;
  };
  ix.obj = HELPERS[helper].make(source, fn);
}

// A controlled inner iterator (flatMap), produced when the user settles a
// mapper promise with a value. Its pulls land in the #m<slot><col> boxes.
function makeInner(slot) {
  ix.inners.set(slot, { pullCount: 0 });
  const inner = {
    next() {
      const col = ix.inners.get(slot).pullCount++;
      const d = Promise.withResolvers();
      recInnerPullPending(slot, col, d);
      return d.promise;
    },
    return() {
      const d = Promise.withResolvers();
      recClosePending('c2', 'inner-return', d);
      return d.promise;
    },
    [Symbol.asyncIterator]() { return this; },
  };
  return inner;
}

// ---- the user-action entry points ----
function doNext() {
  const row = ix.results.length;
  recResultPending(row);
  const p = ix.obj.next();   // synchronously issues whatever pull the helper needs
  ix.results.push(p);
  p.then(
    (v) => recResultSettle(row, v.done ? 'done' : 'value', v.value),
    () => recResultSettle(row, 'error'),
  );
}
function doReturn() {
  recReturnPending();
  ix.obj.return().then(() => recReturnSettle('done'), () => recReturnSettle('error'));
}
function settleStimulus(id, type) {           // type: 'value' | 'done' | 'error'
  const st = stimuli.get(id);
  if (!st) return;
  switch (st.kind) {
    case 'pull':
      recPullSettle(st.row, type);
      if (type === 'value') st.deferred.resolve({ value: letterFor(st.row), done: false });
      else if (type === 'done') st.deferred.resolve({ value: undefined, done: true });
      else st.deferred.reject(new Error('boom'));
      break;
    case 'fn':
      settleFn(st, type);
      break;
    case 'inner': {
      const token = letterFor(st.slot).toLowerCase() + st.col;
      recInnerSettle(st.slot, st.col, type, token);
      if (type === 'value') { ix.innerValueToCell.set(token, { slot: st.slot, col: st.col }); st.deferred.resolve({ value: token, done: false }); }
      else if (type === 'done') st.deferred.resolve({ value: undefined, done: true });
      else st.deferred.reject(new Error('boom'));
      break;
    }
    case 'return':        // underlying .return() (c0)
    case 'inner-return': {// inner-iterator .return() (c2)
      const box = st.kind === 'return' ? 'c0' : 'c2';
      if (type === 'error') { recCloseSettle(box, 'error'); st.deferred.reject(new Error('boom')); }
      else { recCloseSettle(box, 'done'); st.deferred.resolve({ value: undefined, done: true }); }
      break;
    }
  }
}
// Settling a mapper/predicate promise means different things per helper.
function settleFn(st, type) {
  if (ix.helper === 'map') {
    if (type === 'done') return;              // a mapped value can't be `done`
    if (type === 'value') { const m = 'f' + st.arg; ix.valueToSlot.set(m, st.slot); recFnSettleValue(st.slot, m); st.deferred.resolve(m); }
    else { recFnSettleError(st.slot); st.deferred.reject(new Error('boom')); }
  } else if (ix.helper === 'filter') {
    if (type === 'value') { ix.valueToSlot.set(st.arg, st.slot); recFnSettleValue(st.slot, 'true'); st.deferred.resolve(true); }
    else if (type === 'done') { recCompact(st.slot); st.deferred.resolve(false); }   // predicate false -> drop + re-pull
    else { recFnSettleError(st.slot); st.deferred.reject(new Error('boom')); }
  } else {                                    // flatMap
    if (type === 'done') return;              // a mapper iterator can't be `done`
    if (type === 'value') { recFnSettleIterator(st.slot); st.deferred.resolve(makeInner(st.slot)); }
    else { recFnSettleError(st.slot); st.deferred.reject(new Error('boom')); }
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
    cx: +box.getAttribute('x') + Math.min(15, +box.getAttribute('width') / 2),
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
    el = svgEl('path', { class: 'arrow' });
    (BAND[conn[0][0]] === 'closing' ? closingArrows : mainArrows).appendChild(el);
    arrowEls[key] = el;
  }
  el.setAttribute('d', arrowD(conn));   // recomputed: inner boxes can move/resize
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
  // right-click is `done`/`false`. A map/flatMap mapper result can't be done,
  // so right-clicking it does nothing; a filter predicate settles to `false`.
  if (st.kind === 'fn' && ix.helper !== 'filter') return;
  if (!ix.busy) userAction(() => settleStimulus(g.id, 'done'));
});

// ---- enabling/disabling the consumer buttons ----
function updateButtons() {
  const nb = root.querySelector('#next-btn');
  const rb = root.querySelector('#return-btn');
  if (nb) nb.classList.toggle('disabled', !ix || ix.busy);
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
  g.addEventListener('click', () => { if (ix && !ix.busy) userAction(doNext); });

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

// The usage blurb shown at the top of the live tab. The general controls are
// the same for every helper; only the per-element note (what the Internal
// promise is, and what right-clicking it does) changes.
const IX_FN_NOTE = {
  map: 'A mapper promise (<code>f(x)</code>) takes only a value or an error — right-clicking it does nothing.',
  filter: 'On a predicate (<code>pred(x)</code>), <b>click</b> = <code>true</code> (keep) and <b>right-click</b> = <code>false</code> (drop, then re-pull).',
  flatMap: 'Settling a mapper (<code>f(x)</code>) with a value hands back an inner iterator, drawn as its own run of pull boxes; right-clicking it does nothing.',
};
const IX_INSTRUCTIONS = (h) =>
  `This drives the <i>real</i> <code>${h}</code> implementation — your clicks are the stimuli, and the boxes show what it actually does in response. ` +
  'Press <code>.next()</code> (or <code>result.return()</code>) to act as the consumer. Any promise the helper is waiting on wears a glowing dot — settle it yourself: ' +
  '<b>click</b> = a value, <b>right-click</b> = <code>done</code>, <b>shift-click</b> = an error. ' +
  IX_FN_NOTE[h] +
  ' Effects from one tick animate together; input is paused while they play out.';

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
  ixDesc.innerHTML = IX_INSTRUCTIONS(currentSet);
  ixDesc.classList.add('active');

  makeSession(currentSet);
  updateButtons();

  if (urlSync) history.replaceState(null, '', '#' + currentSet + '-interactive');
}

function exitInteractive() {
  if (!interactive) return;
  interactive = false;
  ix = null;
  stimuli.clear();
  // tear down everything the live session materialized, and un-squeeze the
  // static inner rows in case a 5th+ column re-laid them out
  root.querySelectorAll('.dyn').forEach((el) => el.remove());
  for (let s = 0; s < 4; s++) layoutInnerRow(s, 4);
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

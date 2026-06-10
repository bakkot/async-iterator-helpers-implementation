// Animations are authored as *scenarios* (semantic event sequences — see
// scenarios/FORMAT.md) and compiled to step timelines at load time. The
// same scenario files run as tests against the implementation repo.
import { scenarioToAnimation } from './scenarios/scenario-to-animation.js';
import { mapScenarios } from './scenarios/map-scenarios.js';
import { filterScenarios } from './scenarios/filter-scenarios.js';
import { flatMapScenarios } from './scenarios/flatmap-scenarios.js';
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
}

// Switch to a named set (map | filter), rebuild its tabs, and select one of
// its animations (the first by default). The header links reflect the set.
function selectSet(name, index = 0) {
  animations = animationSets[name];
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

nextBtn.addEventListener('click', () => go(step + 1));
prevBtn.addEventListener('click', () => go(step - 1));

window.addEventListener('keydown', (e) => {
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
// id, otherwise fall back to the map set's first animation.
const initial = locateAnim(decodeURIComponent((location.hash || '').slice(1)));
if (initial) selectSet(initial.name, initial.i);
else selectSet('map');
urlSync = true;   // from here on, switches update the hash

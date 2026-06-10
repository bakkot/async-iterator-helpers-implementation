// Smoke test for the scenario format (see
// ../../async-iterator-animations/scenarios/FORMAT.md). Runs the example
// scenarios as real tests against the implementations, and compiles each one
// to an animation, checking that the output only uses the class vocabulary
// the player knows. The conversions of the actual animations/unit tests will
// be exercised the same way once the conversion scripts exist.

import { map } from '../map.js';
import { filter } from '../filter.js';
import { flatMap } from '../flatMap.ts';
import * as utils from './utils.js';
import { scenarioTest } from '../../async-iterator-animations/scenarios/scenario-to-test.js';
import { scenarioToAnimation } from '../../async-iterator-animations/scenarios/scenario-to-animation.js';
import { exampleScenarios } from '../../async-iterator-animations/scenarios/example-scenarios.js';

const helpers = { map, filter, flatMap };

// 1. each scenario compiles to a well-formed animation
const KNOWN_CLASSES = new Set([
  'pending', 'settled', 'errored', 'voided', 'reveal', 'gone', 'shown',
  'up1', 'up2', 'up3', 'shifted',
]);
const SELECTOR = /^#(main|closing|tomb-underlying|tomb-result|[uir][0-5]|c[01]|fi[0-3]|m[0-3][0-3])( \.(box|val|label|sub|divider|err))?$/;
let shapeProblems = 0;
for (const scenario of exampleScenarios) {
  const anim = scenarioToAnimation(scenario);
  for (const [si, step] of anim.steps.entries()) {
    for (const [sel, spec] of step.ops) {
      if (!SELECTOR.test(sel)) {
        console.log(`BAD SELECTOR in ${anim.id} step ${si}: ${sel}`);
        shapeProblems++;
      }
      for (const tok of spec.split(' ')) {
        if (!/^[+-]/.test(tok) || !KNOWN_CLASSES.has(tok.slice(1))) {
          console.log(`BAD CLASS TOKEN in ${anim.id} step ${si}: ${tok}`);
          shapeProblems++;
        }
      }
    }
  }
  console.log(`compiled ${anim.id}: ${anim.steps.length} steps, ${Object.keys(anim.content).length} content boxes`);
}
if (shapeProblems > 0) process.exitCode = 1;

// 2. each scenario passes as a test against the real implementation
await utils.runTests(exampleScenarios.map(
  (s) => scenarioTest(s, { helper: helpers[s.helper], utils }),
));

// Check the ANIMATIONS against the implementation: run the animation
// scenarios (async-iterator-animations/scenarios/*-scenarios.js, the files
// index.html renders) as tests. A failure here means the story an animation
// tells differs from what the implementation actually does — either a real
// disagreement, or (expected, to be hand-corrected in the scenario files) a
// same-tick event order the original animation never specified.

import { map } from '../map.js';
import { filter } from '../filter.js';
import { flatMap } from '../flatMap.ts';
import * as utils from './utils.js';
import { scenarioTest } from '../../async-iterator-animations/scenarios/scenario-to-test.js';
import { mapScenarios } from '../../async-iterator-animations/scenarios/map-scenarios.js';
import { filterScenarios } from '../../async-iterator-animations/scenarios/filter-scenarios.js';
import { flatMapScenarios } from '../../async-iterator-animations/scenarios/flatmap-scenarios.js';

const helpers = { map, filter, flatMap };
const all = [...mapScenarios, ...filterScenarios, ...flatMapScenarios];

await utils.runTests(all.map((s) => scenarioTest(s, { helper: helpers[s.helper], utils })));

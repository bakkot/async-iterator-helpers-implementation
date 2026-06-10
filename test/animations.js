// A failure here means the story an animation tells differs from what the implementation actually does.

import { map } from '../map.js';
import { filter } from '../filter.js';
import { flatMap } from '../flatMap.ts';
import * as utils from './utils.js';
import { scenarioTest } from './scenario-to-test.js';
import { mapScenarios } from '../demo/scenarios/map-scenarios.js';
import { filterScenarios } from '../demo/scenarios/filter-scenarios.js';
import { flatMapScenarios } from '../demo/scenarios/flatmap-scenarios.js';

const helpers = { map, filter, flatMap };
const all = [...mapScenarios, ...filterScenarios, ...flatMapScenarios];

await utils.runTests(all.map((s) => scenarioTest(s, { helper: helpers[s.helper], utils })));

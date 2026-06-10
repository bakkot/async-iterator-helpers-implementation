// Run the unit-test suites for map/filter/flatMap. The suites live as
// scenario files in the animations repo (see ../../async-iterator-animations/
// scenarios/FORMAT.md) — they are the source of truth, converted from the
// former hand-written test/{map,filter,flatMap}.js (since deleted;
// tools/unconvert-tests.js renders them back in that style for review).
//
// Each file is a standalone test file that runs itself at the bottom;
// import them sequentially so their output does not interleave.

await import('../../async-iterator-animations/scenarios/map-test-scenarios.js');
await import('../../async-iterator-animations/scenarios/filter-test-scenarios.js');
await import('../../async-iterator-animations/scenarios/flatmap-test-scenarios.js');

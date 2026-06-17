This project explores async iterator helpers for JavaScript, with support for concurrency (taking the form of multiple calls to `.next()` or `.return()` without waiting for previous calls to settle).

Implementations are in `./map.js`, `./filter.js`, and `.flatMap.ts` (yes, it's intentional that `flatMap` is `.ts`; my version of node can handle it fine with no extra flags).

Unit tests are in `test/{map,filter,flatMap}.js`, run with `npm run test-implementations`. There's also fuzzers you can run with `npm run test-fuzzing`. Do not run the `filter` or `flatMap` fuzzers without the `--fuzz` flag; `--fuzz 100000` is a reasonable amount.

There is also a demo allow you to step through various scenarios aka animations, under `demo`. This uses the same format as (most of) the unit tests, described in `demo/scenarios/FORMAT.md`.

Demo scenarios can be tested against the actual implementation by running `npm run test-animations`.

Visual changes to the demo will be tested by the user; don't try to use a headless browser or otherwise verify except (in the case of new/edited scenarios) by the `npm run test-animations` check.

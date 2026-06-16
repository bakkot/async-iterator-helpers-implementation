# Concurrent async iterator helpers

This repo is for me to mess around with possible behaviors for [async iterator helpers for JavaScript](https://github.com/tc39/proposal-async-iterator-helpers).

The implementations ([map.js](./map.js), [filter.ts](./filter.ts), [flatmap.ts](./flatMap.ts)) are written by me and are intended as the actual source of truth for how I think these should behave prior to writing spec text. I've made an effort to make them readable, and more-or-less succeeded for `map` and `filter`, but `flatMap` is still way more complicated than I'd like.

There is a [demo](http://bakkot.github.io/async-iterator-helpers-implementation) which has a bunch of hand-written scenarios which demonstrate various behaviors, and also lets you play around with it yourself by clicking boxes which represent various Promises. This is hooked up to the actual implementation. Visualizer was mostly written by Claude.

There are also tests but these are almost 100% written by Claude and I haven't looked at them much. They're just to make it easier for me to see when something changes (and how) when I change the implementation. I do not recommend reading them.

All prose in this repo (including comments in the implementations, but not the Claude-authored files) was written by me without an LLM contributing.

## Not yet covered

The implementations have some parts not yet implemented, including at least:

- defensiveness against throwy `next` and `done` getters
- defensiveness against reentrancy
- support for the `flatMap` helper returning sync iterables, or non-iterable iterators
- fast paths for primitive return values (especially for `filter)

## Not yet implemented

In addition to the core three above, I would like an MVP of the proposal to include at least:
- `AsyncIterator.prototype.forEach` and friends, ideally with concurrency support (2nd argument) but I think the MVP might need to leave that out, in which case I want these to throw if passed the second argument (so we can use it later)
- `AsyncIterator.from` and `Iterator.prototype.toAsync`
- `AsyncIterator.prototype.buffered` (like [Rust](https://docs.rs/futures/latest/futures/stream/trait.StreamExt.html#method.buffered)'s `futures` crate)

## Not in this proposal, but needed

Concurrency really wants cancelation, which means [`AbortController`](https://github.com/bakkot/structured-concurrency-for-js).

And in order to adopt cancelation for iterators there needs to be some way to trigger an `AbortController`, which means a `withCleanup` method which registers a callback to be called when `.return()` is invoked (_before_ waiting on the inner `.return`, because [async generators block the `.return()` call until all queued `.next()`s have finished](https://github.com/tc39/proposal-async-iteration/issues/126) - after is also useful in some cases, so we might need an option here).

I would also like to have [a method for converting a _sync_ iterator of Promises into an async iterator by racing the Promises](https://github.com/tc39/proposal-async-iterator-helpers/issues/21).

Someday we need all the other iterator helper methods like `zip`, `join`, `concat`, `chunks`, some of which will need to be designed for concurrency (e.g. `zip` needs to support multiple pulls).

Finally of course there's [unordered versions of the helpers](https://github.com/tc39/proposal-unordered-async-iterator-helpers) as well as [customizable concurrency control](https://github.com/michaelficarra/proposal-concurrency-control).

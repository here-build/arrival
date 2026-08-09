# The TICK Protocol: Cooperative Scheduling for Embedded Interpreters

> Extracted from the paper sketch `docs/thinking/papers/arrival-scheme-flat-trampoline.md`
> (§"The TICK Protocol"), which remains in docs/thinking/papers/. The live implementation is
> `src/eval/evaluator.ts` (`const TICK = Symbol("tick")` and the runner's TICK branch).

## Problem

Embedded interpreters in event-loop environments (browsers, Workers) must not block the event loop.
Traditional approaches:

- Run a fixed number of steps then return (requires step counting in evaluator — pollutes logic)
- Use setTimeout/setInterval (coarse-grained, 4ms minimum in browsers)
- Use Web Workers (separate thread, complex marshalling)

## Solution

The evaluator yields `TICK` at natural evaluation boundaries (function calls, loop iterations).
The runner checks wall-clock time and iteration count:

```typescript
if (value === TICK) {
  iterations++;
  if (iterations > 1000 || performance.now() - lastYield > 5) {
    await Promise.resolve();  // Minimal yield — just microtask
    lastYield = performance.now();
    iterations = 0;
  }
  continue;
}
```

**Key properties**:

- Evaluator logic is clean — just `yield TICK` at boundaries
- Runner controls scheduling policy without evaluator changes
- 5ms threshold matches requestAnimationFrame cadence
- `Promise.resolve()` is the cheapest possible yield (microtask, not macrotask)
- Iteration count avoids `performance.now()` overhead on short operations

## Why This Matters for Cloudflare Workers

Workers have a 50ms CPU time limit per request (configurable). Without cooperative yielding, a
Scheme computation that takes 30ms of CPU time would appear to be unresponsive — the runtime can't
process other events. With TICK yielding, the computation breathes every ~5ms, allowing the Workers
runtime to handle other concerns.

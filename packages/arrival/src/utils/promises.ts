// Promise utilities for the trampoline's async seams.
//
// Structures hold promise-valued members INERT — the membrane's Promise row is "raw
// passthrough, the trampoline awaits". The interpreter awaits lazily at the seams
// where a value is actually NEEDED: the trampoline's settle points, the HOF
// result-collection sites (`promise_all` below), and the op-return seam. Eager
// traversal of structures to hunt promises is exactly the work this design avoids —
// a scheme callable structurally cannot return a raw array or plain object (an
// AValue has a class prototype), so the only live callers ever hand these utilities
// boxed SchemeValues (or promises thereof), never a structure to walk.

import { is_promise } from "../eval/guards.js";

/** Promise.all over a result array; non-arrays pass through unchanged. The HOF
 *  result-collection seam (map/filter/for-each families): callbacks may be async,
 *  so collected results are awaited ONCE, at the point the whole collection is
 *  needed — single level, no structure traversal. */
export function promise_all(arg: unknown[]): Promise<unknown[]> | unknown[] {
  if (Array.isArray(arg)) {
    return Promise.all(arg);
  }
  return arg;
}

/** Sync-fast-path `then`: apply `fn` to a maybe-promise WITHOUT taxing the sync
 *  case with a microtask. A synchronous value stays synchronous (the trampoline's
 *  performance contract); a promise chains. This is the single-promise seam for
 *  "the callback might be async" — it never traverses structures. */
export function maybeThen(
  value: unknown,
  fn: (x: unknown) => unknown,
  error: ((e: unknown) => void) | null = null,
): unknown {
  if (is_promise(value)) {
    const ret = (value as Promise<unknown>).then(fn);
    return error === null ? ret : ret.catch(error);
  }
  return fn(value);
}

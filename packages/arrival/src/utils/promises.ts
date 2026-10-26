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
//
// Cross-cutting leaf: consumed by values/primitives (APair/AVector/pending-entry),
// env/*, and eval/call-function.ts alike, so it stays in utils/ rather than inside
// any one layer (living in eval/ would reintroduce a values→eval edge). Its only
// dependency is the value-kernel predicate `is_promise` (values/value-guards.ts).

import { is_promise } from "../values/value-guards.js";
import type { MaybePromise } from "../types/utility.js";

/** HOF result-collection awaits one level when the whole collection is needed. */
export function promise_all<T>(arg: readonly MaybePromise<T>[]): Promise<T[]> {
  return Promise.all(arg);
}

/** Sync-fast-path `promise_all`: an all-settled list stays synchronous (no microtask);
 *  any pending slot makes the whole list a promise. Pair with `maybeThen`. */
export function settleAll<T>(arg: readonly MaybePromise<T>[]): MaybePromise<T[]> {
  return arg.some(is_promise) ? promise_all(arg) : (arg as T[]);
}

/** Sync-fast-path `then`: apply `fn` to a maybe-promise WITHOUT taxing the sync
 *  case with a microtask. A synchronous value stays synchronous (the trampoline's
 *  performance contract); a promise chains. The single-promise seam for "the
 *  callback might be async". */
export function maybeThen<T, U>(
  value: MaybePromise<T>,
  fn: (x: T) => MaybePromise<U>,
  error: ((e: unknown) => MaybePromise<U>) | null = null,
): MaybePromise<U> {
  if (is_promise(value)) {
    const ret = (value as Promise<T>).then(fn);
    return error === null ? ret : ret.catch(error);
  }
  return fn(value as T);
}

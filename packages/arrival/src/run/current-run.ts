/**
 * currentRun — the ONE sanctioned module-level ambient (P19, docs/execution.md §1).
 *
 * Why it exists at all: codec seams (toJS / fromJS / membrane crossings called from host
 * JS) carry no RunContext handle and cannot be given one without changing their public
 * signatures. Everything else rides the RunContext explicitly.
 *
 * Why it is tolerable: it is a SYNC window. `withCurrentRun` sets the pointer, runs a
 * synchronous body, and restores the previous pointer before returning. A single-threaded
 * isolate cannot interleave anything inside a sync body, so two concurrent runs never
 * observe each other's pointer. The tripwire below keeps it that way: a body that returns
 * a thenable would hold the pointer across an await boundary, so it is refused with a door.
 */

import { assertSingleLoad } from "../single-load.js";
import { AmbientWindowError, type RunContext } from "./RunContext.js";

// The holder below is module-local: a bundler that evaluates this module twice would split it.
assertSingleLoad("run/current-run");

let current: RunContext | undefined;

/** The RunContext whose sync window the caller is inside, or `undefined` outside any window. */
export function currentRun(): RunContext | undefined {
  return current;
}

/** Run a SYNCHRONOUS `fn` with `runCtx` as {@link currentRun}; restores the previous pointer on
 *  every exit. Throws {@link AmbientWindowError} if `fn` returns a thenable. */
export function withCurrentRun<T>(runCtx: RunContext, fn: () => T): T {
  const prev = current;
  current = runCtx;
  let result: T;
  try {
    result = fn();
  } finally {
    current = prev;
  }
  if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
    throw new AmbientWindowError(
      "withCurrentRun: the window body returned a thenable. The current-run pointer is a SYNC window (an await boundary would let a concurrent run observe it); pass the RunContext explicitly across async work.",
    );
  }
  return result;
}

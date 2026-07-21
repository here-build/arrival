// ----------------------------------------------------------------------
// Function application chokepoint.
//
// `call_function` applies a Scheme function value (a native builtin OR a
// generator-lambda) with a fresh call frame. Crucially it does NOT touch the
// legacy evaluator: a generator-lambda, when applied here via `fn.apply`,
// returns `run(evalBegin(body))` itself (evaluator.ts — the `_canBounce`
// === false branch), so the generator drives the body. This is why the HOFs
// (map/filter/fold) work through `call_function` today — env/r7rs/lists.ts
// is the live consumer.
//
// `resolve_promises` collapses a tree of promises into a single promise (or
// returns the argument untouched when there are none).
//
// Both are self-contained (AmbientRuntime frame + LambdaContext + value kernel),
// so a stdlib pack can import the applier without pulling in the evaluator.
// ----------------------------------------------------------------------
import { is_promise } from "./guards.js";
import { CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
import { makeCallCtx } from "../run/CallCtx.js";
import { is_callable_value } from "../values/value-guards.js";
import { applyCallback, type ACallable } from "../values/primitives/ACallable.js";
import { LambdaContext } from "./LambdaContext.js";
import { APair } from "../values/primitives/APair.js";
import { DATA } from "../well-known-symbols.js";
import type { SchemeValue } from "../values/types.js";
import { promise_all } from "../utils/promises.js";

type SchemeFunction = (...args: any[]) => any;

// `runCtx` is REQUIRED (Wave 0 of the CONSTANT_CTX rework §2.1): the old
// `{ runCtx }: {...; runCtx?:
// RunContext } = {}` shape let a caller pass nothing at all — and real callers did
// (env/r7rs/lists.ts's map/member/assoc, before this wave, invoked with `{}`), so every
// `map`/`member`/`assoc` callback ran with no abort signal, no heap meter, forced
// non-strict, regardless of the run's actual configuration. Making it required turns that
// silent drop into a compile error at every call site.
export function call_function(
  fn: SchemeFunction | ACallable,
  args: SchemeValue[],
  { use_dynamic, runCtx }: { use_dynamic?: boolean; runCtx: RunContext },
) {
  // A callable VALUE (ANativeProcedure/ALambda/ARosettaProcedure) is invoked through the
  // seam — its apply term, a CallCtx threaded — not as a bare fn (`fn.apply` would throw
  // "apply called on an object, not a function"). Bare fns keep the LambdaContext path below.
  // No live invocation reaches this chokepoint (only a bare `runCtx` parameter) — a real
  // CallCtx with invocation undefined, degraded exactly as the pre-CallCtx-threading path.
  if (is_callable_value(fn)) {
    return resolve_promises(applyCallback(fn, args, makeCallCtx(runCtx)) as SchemeValue);
  }
  // No call frame is built: a generator-lambda carries its own closure env, a
  // native reads none, so no frame is needed here. Only `use_dynamic` rides the
  // LambdaContext brand the membrane keys off.
  const context = new LambdaContext({ use_dynamic });
  return resolve_promises(fn.apply(context, args));
}

// Collapse a tree that may contain Promises into a single Promise; if the tree
// holds none, return the argument untouched (the common no-await fast path).
function resolve_promises(arg: SchemeValue): SchemeValue {
  const promises: Promise<unknown>[] = [];
  traverse(arg);
  if (promises.length > 0) {
    return resolve(arg);
  }
  return arg;

  function traverse(node) {
    if (is_promise(node)) {
      promises.push(node);
    } else if (node instanceof APair) {
      if (!node.have_cycles("car")) {
        traverse(node.car);
      }
      if (!node.have_cycles("cdr")) {
        traverse(node.cdr);
      }
    } else if (Array.isArray(node)) {
      node.forEach(traverse);
    }
  }

  async function promise(node) {
    const pair = new APair(node.have_cycles("car") ? node.car : await resolve(node.car),
      node.have_cycles("cdr") ? node.cdr : await resolve(node.cdr),
    );
    if (node[DATA]) {
      pair[DATA] = true;
    }
    return pair;
  }

  function resolve(node) {
    if (Array.isArray(node)) {
      return promise_all(node.map(resolve));
    }
    if (node instanceof APair && promises.length > 0) {
      return promise(node);
    }
    return node;
  }
}

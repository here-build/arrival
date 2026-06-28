// ----------------------------------------------------------------------
// Function application chokepoint — extracted from lips.ts (keystone K1a).
//
// `call_function` applies a Scheme function value (a native builtin OR a
// generator-lambda) with a fresh call frame. Crucially it does NOT touch the
// legacy evaluator: a generator-lambda, when applied here via `fn.apply`,
// returns `run(evalBegin(body))` itself (evaluator.ts — the `_canBounce`
// === false branch), so the generator drives the body. This is why the HOFs
// (map/filter/fold) work through `call_function` today.
//
// `resolve_promises` collapses a tree of promises into a single promise (or
// returns the argument untouched when there are none).
//
// Both are self-contained (Environment frame + LambdaContext + value kernel),
// so the stdlib (K1b) and the reader can import the applier without importing
// lips.ts.
// ----------------------------------------------------------------------
import { is_promise } from "./guards.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { LambdaContext } from "./LambdaContext.js";
import { APair } from "../values/primitives/APair.js";
import { DATA } from "../well-known-symbols.js";
import type { SchemeValue } from "../values/types.js";
import { promise_all } from "../utils/promises.js";
import { is_pair } from "../values/value-guards.js";

type SchemeFunction = (...args: any[]) => any;

export function call_function(
  fn: SchemeFunction,
  args: SchemeValue[],
  { use_dynamic }: SchemeValue = {},
) {
  // F1/F2 dissolved (P3 3b.3 step 6): the callers (the HOF dispatch in env/r7rs/lists.ts)
  // always pass `{}`, so `env`/`dynamic_env` were always undefined and `env?.new_frame(...)`
  // always short-circuited — `new_frame` was a phantom (no definition; the optional-chain
  // never invoked it) and the call frame vestigial. A generator-lambda carries its own
  // closure env, a native reads none, so no frame is needed here. Only `use_dynamic` rides
  // the LambdaContext brand the membrane keys off. Seeds P5.
  const context = new LambdaContext({ use_dynamic });
  return resolve_promises(fn.apply(context, args));
}

// Collapse a tree that may contain Promises into a single Promise; if the tree
// holds none, return the argument untouched (the common no-await fast path).
export function resolve_promises(arg: SchemeValue): SchemeValue {
  const promises: Promise<unknown>[] = [];
  traverse(arg);
  if (promises.length > 0) {
    return resolve(arg);
  }
  return arg;

  function traverse(node) {
    if (is_promise(node)) {
      promises.push(node);
    } else if (is_pair(node)) {
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
    const pair = new APair(CONSTANT_CTX, 
      node.have_cycles("car") ? node.car : await resolve(node.car),
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
    if (is_pair(node) && promises.length > 0) {
      return promise(node);
    }
    return node;
  }
}

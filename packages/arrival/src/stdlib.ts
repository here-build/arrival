/**
 * Forked from LIPS.js - Scheme-based Lisp interpreter
 * Copyright (c) 2018-2024 Jakub T. Jankiewicz <https://jcubic.pl/me>
 * Released under the MIT license
 * https://github.com/jcubic/lips
 */
import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import { ctxOf } from "./values/primitives/AValue.js";
import { withInputProvenance } from "./values/op-helpers.js";
import { Environment, KEYWORD_ACCESSOR_FIELD, type EnvironmentValue } from "./Environment.js";
import { global_env, user_env } from "./env-roots.js";
import { tokenize } from "./reader/tokenize.js";
import { findHeapMeter, heapBudgetMessage } from "./heap-budget.js";
import { eof } from "./values/primitives/EOF.js";
import { AHalfBaked } from "./values/primitives/AHalfBaked.js";
import { Lexer } from "./reader/Lexer.js";

import { _parse } from "./reader/parse.js";
import { QuotedPromise } from "./values/primitives/QuotedPromise.js";
import {
  is_env,
  is_false,
  is_function,
  is_nil,
  is_null,
  is_pair,
  is_plain_object,
  is_promise,
} from "./eval/guards.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { restore_data_gensyms, extract_patterns, transform_syntax } from "./eval/syntax-rules.js";
import { box, patch_value, quote } from "./reader/values-repr.js";
import { toString, unbox, map_object, symbolize } from "./printer.js";
import {
  complex_bare_re,
  complex_re,
  float_re,
  int_bare_re,
  int_re,
  rational_bare_re,
  rational_re,
} from "./values/primitives.js";
import { nil } from "./values/primitives/ANil.js";
import * as specials from "./reader/specials.js";
import { call_function } from "./eval/call-function.js";
import { type, typecheck, typeErrorMessage } from "./utils/typecheck.js";
import { parse_complex, parse_float, parse_integer, parse_rational } from "./utils/parsing.js";
import { Values } from "./values/primitives/Values.js";
import { available_class, class_map } from "./reader/serialize.js";
import { Macro } from "./eval/Macro.js";
import { Syntax } from "./eval/Syntax.js";
import { isCircularList, APair, concatPair } from "./values/primitives/APair.js";
import { promise_all, unpromise } from "./utils/promises.js";

import { ABool } from "./values/primitives/ABool.js";
import {
  keywordAccessorResolver,
  NOT_FOUND,
  accessMember,
  InteropAccessError,
} from "./membrane.js";
import { AJSObject } from "./values/primitives/js-wrappers.js";
import { collapseProvenance, taintString } from "./provenance-collapse.js";
import { type EvalContext, currentRunEnv, isSpeculating, ArrivalError } from "./eval/evaluator.js";


// Type definitions for dynamic Scheme values
// Scheme is inherently dynamic - these use `any` intentionally for interpreter interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeValue = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeFunction = (...args: any[]) => any;

// -------------------------------------------------------------------------

// Dev-only structured tracer for the syntax-rules expander. Gated by the per-run
// `debug` interpreter option (RunContext.debug) — threaded to the expander via the
// macro invoke's runCtx, NOT a Scheme `DEBUG` variable and NOT module debug-state, so
// it is inert by default and hermetic across concurrent runs. Mirrors the console API
// so traces NEST (group/groupEnd) and are TIMED; `debugFmt` renders SchemeValues with
// full depth, JS-string args passing through as labels.
/* c8 ignore start */
let debugSeq = 0;
function debugFmt(x: SchemeValue): unknown {
  return typeof x === "string"
    ? x
    : is_plain_object(x)
      ? map_object(x, (value: SchemeValue) => toString(value, true))
      : toString(x, true);
}
// `makeDebugTracer(on)` returns the tracer the expander uses; `on` is this run's
// RunContext.debug. Off ⇒ every method is a no-op, so the expander stays silent.
function makeDebugTracer(on: boolean) {
  return {
    log: (...args: SchemeValue[]): void => {
      if (on) console.log(...args.map(debugFmt));
    },
    dir: (x: unknown): void => {
      if (on) console.dir(x, { depth: null });
    },
    group: (label: SchemeValue): void => {
      if (on) console.group(debugFmt(label));
    },
    groupEnd: (): void => {
      if (on) console.groupEnd();
    },
    time: (label: string): void => {
      if (on) console.time(label);
    },
    timeEnd: (label: string): void => {
      if (on) console.timeEnd(label);
    },
  };
}
/* c8 ignore stop */

// symbol_to_string relocated to printer.ts (used only by its function_to_string).

// ----------------------------------------------------------------------
specials.on(["remove", "append"], function () {
  Lexer._cache.valid = false;
  Lexer._cache.rules = null;
});

// ----------------------------------------------------------------------
// :: Tokens are the array of strings from tokenizer
// :: the return value is an array of lips code created out of Pair class.
// :: env is needed for parser extensions that will invoke the function
// :: or macro assigned to symbol, this function is async because
// :: it evaluates the code, from parser extensions, that may return a promise.
// ----------------------------------------------------------------------
// _parse moved to reader/parse.ts (imported above); the reader is now a monolith-free leaf.

// Re-export unpromise from utils/promises
export { unpromise } from "./utils/promises.js";

// ----------------------------------------------------------------------
// :: Function that return matcher function that match string against string
// ----------------------------------------------------------------------
function matcher(name, arg) {
  if (arg instanceof RegExp) {
    return (x) => String(x).match(arg);
  } else if (is_function(arg)) {
    // it will always be function
    return arg;
  }
  throw new Error("Invalid matcher");
}

// ----------------------------------------------------------------------
function to_array(name: string, deep = false): SchemeFunction {
  return function recur(list: SchemeValue): SchemeValue[] {
    typecheck(name, list, ["pair", "nil"]);
    if (is_nil(list)) {
      return [];
    }
    // have_cycles() below only catches reader #0= cycles; actively detect a
    // runtime set-cdr! cycle so we raise a clean error instead of growing the
    // array until "Invalid array length" (the reverse symptom).
    invariant(!isCircularList(list), `${name}: can't convert a circular list`);
    // Per-run allocation bound: `to_array` is the choke point every collection op (filter/map/append/
    // join) funnels through, so charging materialized elements HERE catches the O(K²)-churn runaway
    // that the TICK-cadence wall-clock budget can't preempt (a single native list pass emits no TICK).
    // Look the meter up ONCE (O(depth)); the per-element check is a bare int compare. Undefined ⇒ no
    // budget requested ⇒ zero overhead beyond the lookup. The run env comes from the evaluator's
    // run-scoped `currentRunEnv()` (set at the apply boundary) — env-as-`this` is fully erased.
    const runEnv = currentRunEnv();
    const meter = findHeapMeter(runEnv ?? null);
    const result: SchemeValue[] = [];
    let node = list;
    while (true) {
      if (is_pair(node)) {
        if (node.have_cycles("cdr")) {
          break;
        }
        let car = node.car;
        if (deep && is_pair(car)) {
          // tree->array deep recursion (untested branch): resolve the recursive
          // fn from the run env (was `this.get(name)`), now `currentRunEnv()`.
          car = (runEnv?.get(name) as SchemeFunction)(car);
        }
        result.push(car);
        if (meter !== undefined && ++meter.used > meter.max) {
          throw new ArrivalError(heapBudgetMessage(meter.max), []);
        }
        node = node.cdr;
      } else {
        invariant(is_nil(node), `${name}: can't convert improper list`);
        break;
      }
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Shared list/array core impls — module-scope so sibling builtins (append,
// reverse, map, join, …) CALL them directly instead of reaching through
// `global_env.get("list->array")` for a sibling they can't name lexically. The
// global-env bindings below are these same functions; calling them directly is
// behavior-identical (already early-bound today) and avoids a per-call env lookup.
// ---------------------------------------------------------------------------
const listToArray = to_array("list->array");

function isProperList(obj: SchemeValue): SchemeValue {
  // A circular list is NOT a proper list (R7RS). Detect runtime cycles
  // (have_cycles below only catches reader #0= cycles).
  if (is_pair(obj) && isCircularList(obj)) {
    return false;
  }
  let node = obj;
  while (true) {
    if (is_nil(node)) {
      return true;
    }
    if (!is_pair(node)) {
      return false;
    }
    if (node.have_cycles("cdr")) {
      return false;
    }
    node = node.cdr;
  }
}

function mapImpl(fn: SchemeFunction, ...lists: SchemeValue[]): SchemeValue {
  typecheck("map", fn, "function");
  const is_list = isProperList;
  for (const [i, arg] of lists.entries()) {
    typecheck("map", arg, ["pair", "nil"], i + 1);
    // detect cycles
    invariant(!is_pair(arg) || is_list(arg), `map: argument ${i + 1} is not a list`);
  }
  if (lists.length === 0 || lists.some(is_nil)) {
    return nil;
  }

  // Convert lists to arrays for parallel processing
  const arrays = lists.map((l) => listToArray(l));
  const length = Math.min(...arrays.map((a: SchemeValue[]) => a.length));

  // Call function for all elements in parallel. (Formerly destructured
  // {env,dynamic_env,use_dynamic} off env-as-`this` — all always undefined, so
  // call_function got an empty options bag; passing {} directly is identical and
  // drops the last `this` read here.)
  const results: SchemeValue[] = [];
  for (let i = 0; i < length; i++) {
    const args = arrays.map((arr: SchemeValue[]) => arr[i]);
    results.push(call_function(fn, args, {}));
  }

  // Wait for all and convert back to list
  const hasPromises = results.some(is_promise);

  // Tier-2 speculation: map's count is known exactly up front (one output
  // per input → bounds [1,1]), so its `HalfBaked` interval is already a
  // point — `length` is decidable immediately while values still resolve.
  // This carries speculation THROUGH a map sitting between filter and the
  // length/comparison (the values stay lazy; only the count is surfaced).
  if (hasPromises && isSpeculating()) {
    const slots = results.map((r) => Promise.resolve(r).then((v) => [v as SchemeValue]));
    return AHalfBaked.collection(ctxOf(lists[0]), slots, () => [1, 1]);
  }
  if (hasPromises) {
    return (promise_all(results) as Promise<unknown[]>).then((resolved) =>
      APair.fromArray(ctxOf(lists[0]), resolved as SchemeValue[]),
    );
  }
  return APair.fromArray(ctxOf(lists[0]), results);
}

// Old Pair prototype methods are now in the Pair class above

// The value→string printer — `toString`, its repr registry (get_instances /
// get_native_types / user_repr / function_to_string / the `repr` map + str_mapping),
// plus `symbolize` and the `unbox` / `map_object` helpers — relocated to printer.ts.
// It is a top-level module beside stdlib (it must know every printable type, incl.
// Environment/Macro/Values, so it is not a values/ leaf); imported above for the
// builtins/tracer that print. Never exported, so it is not on the public barrel.

// ----------------------------------------------------------------------
// eq/eqv moved to structural-equal.ts; the macro engine (macro_expand /
// extract_patterns / restore_data_gensyms / transform_syntax / self_evaluated)
// moved to syntax-rules.ts (keystone K3) and is imported above.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// :: Function utilities
// ----------------------------------------------------------------------
// box() relocated to reader/values-repr.ts (the value-representation leaf,
// alongside quote/patch_value); imported above. Re-exported below for the barrel.

// ----------------------------------------------------------------------
// patch_value relocated to reader/values-repr.ts; re-exported to preserve the
// public barrel surface (mirrors the quote re-export below).
export { box, patch_value } from "./reader/values-repr.js";

// ----------------------------------------------------------------------
// :: Stub macros for let/let*/letrec - generator evaluator handles these as special forms
// :: These stubs exist only for LIPS evaluate compatibility during bootstrap
// ----------------------------------------------------------------------
// let_macro removed — let/let*/letrec/letrec* now delegate to generator evaluator via genMacroWrapper

// -------------------------------------------------------------------------
// :: Quote function used to pause evaluation from Macro
// -------------------------------------------------------------------------
// quote moved to values-repr.ts; re-exported here to preserve the public barrel.
export { quote } from "./reader/values-repr.js";

// -------------------------------------------------------------------------------
const native_lambda = _parse(
  tokenize(`(lambda ()
                                        "[native code]"
                                        (throw "Invalid Invocation"))`),
)[0];
// -------------------------------------------------------------------------------
// Native property accessor — interpreter infrastructure below the membrane. NOT a
// Scheme-facing builtin: the `.` / `get` verbs that exposed this
// to Scheme code were removed (the host-language sweep) — Scheme reaches host data
// only through the blessed `@` / `@?` / `@keys` membrane accessors now. Access still
// routes through accessMember / SchemeJSObject.get so the membrane is enforced.
export const get = function get(object, ...args) {
  let value;
  while (args.length > 0) {
    const arg = args.shift();
    const name = unbox(arg);
    // the value was set to false to prevent resolving
    // by Real Promises #153
    if (name === "then" && object instanceof QuotedPromise) {
      value = QuotedPromise.prototype.then;
    } else if (name === "__code__" && is_function(object) && object.__code__ === undefined) {
      value = native_lambda;
    } else if (object instanceof AJSObject) {
      // Use SchemeJSObject.get() for interop membrane access
      value = object.get(name);
    } else {
      // Route raw property access through the SAME isolation as `@` /
      // SchemeJSObject.get: blocked names (constructor, __proto__, prototype, …)
      // and inherited props past the interop boundary (Function.prototype.*,
      // Array.prototype.*) must not be reachable via dot-notation — otherwise
      // `f.constructor("…")()` is RCE. Absent or blocked → undefined, the
      // chain-terminator the `value === undefined` check below already handles.
      const key = typeof name === "symbol" ? name : String(name);
      try {
        const accessed = accessMember(object, key);
        value = accessed === NOT_FOUND ? undefined : accessed;
      } catch (e) {
        if (e instanceof InteropAccessError) {
          value = undefined;
        } else {
          throw e;
        }
      }
    }
    if (value === undefined) {
      invariant(args.length === 0, () => `Try to get ${args[0]} from undefined`);
      return value;
    } else {
      value = patch_value(value);
    }
    object = value;
  }
  return value;
};
// -------------------------------------------------------------------------
const internal_env = new Environment(
  "internal",
  {
    // those will be compiled by babel regex plugin
    "letter-unicode-regex": /\p{L}/u,
    "numeral-unicode-regex": /\p{N}/u,
    "space-unicode-regex": /\s/u,
  },
  undefined,
);
// ----------------------------------------------------------------------

const is_node = () => typeof process === "object" && !!process.env;

// -------------------------------------------------------------------------
// :: Thin wrapper: delegates a special form to the generator evaluator.
// :: LIPS evaluate dispatches to these Macros, which hand off to the
// :: generator's evaluate + run. This lets us delete the complex,
// :: poorly-typed LIPS Macro implementations for forms the generator
// :: already handles correctly.
// -------------------------------------------------------------------------
// genMacroWrapper removed — define/lambda are kernel keywords (symbol.keyword markers)
// on scheme/core; the evaluator dispatches them by resolved-marker value, no husk needed.

// -------------------------------------------------------------------------
// The native root's inline builtins. `global_env` is created EMPTY in the env-roots
// leaf so the evaluator entry + bridge can source the root without importing this
// monolith; we register the builtins onto it HERE, at the same module-load point the
// constructor used to occupy. `Object.assign` onto `__env__` is the faithful
// equivalent of the old `new Environment("global", {...})` — the ctor stores
// `__env__` and runs no logic, so the resulting binding set is byte-identical.
Object.assign(global_env.__env__, {
    undefined, // undefined as parser constant breaks most of the unit tests
    // ------------------------------------------------------------------
    // Spec §5.3 car/cdr element-only provenance.
    //
    // War story: previously `withInputProvenance([list], list.car)` unioned
    // the *container*'s provenance into the *element*'s — so `(car xs)`
    // returned a value stamped with every id that contributed to xs, even
    // those carried by sibling cdr elements or the spine itself. That violates
    // the spec §5.3 rule that car/cdr are *projections*: the result inherits
    // ONLY the element's own provenance, not the container's. The audit
    // surfaced this as the algebra gap behind a class of phantom-contributor
    // attributions in downstream consumers.
    //
    // Fix: pass `list.car` (resp. `list.cdr`) as the single provenance input.
    // - If element is an AValue, `withInputProvenance` re-stamps with its own
    //   provenance (effectively a no-op clone — preserves element identity).
    // - If element is raw JS (string/bool/number), `withInputProvenance`
    //   skips work because `inputs.length === 0`; the element is returned
    //   unchanged, which is correct because raw values have no container-
    //   borrowed provenance to incorrectly carry.
    //
    // `cons`, `list`, and `length` are CONSTRUCTORS / aggregations, not
    // projections — they correctly retain `withInputProvenance([car, cdr], …)`
    // unioning over all inputs.
    // `(dict :k v …)` — the canonical open-key map form, companion to the
    // `(:key d)` accessor. A keyword in argument position evaluates to its
    // property accessor, branded with the bare key via KEYWORD_ACCESSOR_FIELD;
    // read that to build a plain object. The serializer prints `(dict …)`, and
    // arrival-chain-view transpiles it to a JS/Python object literal.
    dict: function dict(...args: SchemeValue[]) {
      const obj: Record<string, SchemeValue> = {};
      for (let i = 0; i + 1 < args.length; i += 2) {
        const k = args[i] as { [KEYWORD_ACCESSOR_FIELD]?: string } | null;
        const key =
          (k != null && (typeof k === "function" || typeof k === "object") && k[KEYWORD_ACCESSOR_FIELD]) ||
          String(args[i]).replace(/^:/, "");
        obj[key] = args[i + 1];
      }
      return obj;
    },
    // ------------------------------------------------------------------
    // set-car! / set-cdr! / append! — OMITTED by the purity invariant (every
    // entity is frozen by design). Doored in r7rs/lists. See plan-2026-06-11.
    // set! / do / if / letrec / letrec* / let* / let / begin / parameterize —
    // VESTIGIAL global_env registrations of forms the evaluator's SPECIAL_FORMS
    // table already shadows before env lookup (parameterize is doored in r7rs/control).
    // Deleted: no first-class lookup reaches them, and macro_expand's traverse
    // only special-cases `lambda`/`define` by identity (the `let` family by name),
    // so the bindings are unreferenced. See husk-dissolution pass.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // define / lambda — now KERNEL KEYWORDS (symbol.keyword markers) on the
    // scheme/core pack (env/core/core.ts), NOT genMacroWrapper husks here. The
    // evaluator resolves a call head through the env and dispatches on the marker
    // VALUE (SPECIAL_FORMS[kw.name]) — so special-ness travels with the value:
    // `(define => lambda)` aliases the marker, lexical shadowing un-specials it,
    // and macro_expand's `value === env.get("lambda")` identity check resolves to
    // the same marker by inheritance. No first-class husk needed here.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // define-macro — VESTIGIAL: shadowed by the `define-macro` SPECIAL_FORM
    // (evalDefineMacro) before env lookup; no first-class reader. Deleted.
    // ------------------------------------------------------------------
    "syntax-rules": new Macro("syntax-rules", function (this: Environment, macro: SchemeValue, options: SchemeValue) {
      const { use_dynamic, error } = options;
      // TODO: find identifiers and freeze the scope when defined #172
      const env = this;

      function get_identifiers(node: SchemeValue) {
        const symbols: SchemeValue[] = [];
        while (!is_nil(node)) {
          const x = node.car;
          symbols.push(x.valueOf());
          node = node.cdr;
        }
        return symbols;
      }

      function validate_identifiers(node) {
        while (!is_nil(node)) {
          const x = node.car;
          TypeError.invariant(x instanceof ASymbol, "syntax-rules: wrong identifier");
          node = node.cdr;
        }
      }

      if (macro.car instanceof ASymbol) {
        validate_identifiers(macro.cdr.car);
      } else {
        validate_identifiers(macro.car);
      }
      const syntax = new Syntax(function (this: Environment, code: SchemeValue, { macro_expand, runCtx }: SchemeValue) {
        const debug = makeDebugTracer(runCtx?.debug === true);
        const trace = `syntax-expand #${++debugSeq}`;
        debug.group(code);
        debug.time(trace);
        debug.log("macro:", macro);
        const scope = env.inherit("syntax");
        const dynamic_env = scope;
        let var_scope: Environment = this;
        // for macros that define variables used in macro (2 levels nestting)
        if ((var_scope.__name__ as string | symbol) === Syntax.__merge_env__) {
          // copy refs for defined gynsyms
          const props = Object.getOwnPropertySymbols(var_scope.__env__);
          for (const symbol of props) {
            var_scope.__parent__!.set(symbol, var_scope.__env__[symbol]);
          }
          var_scope = var_scope.__parent__!;
        }
        const eval_args = { env: scope, dynamic_env, use_dynamic, error };
        let ellipsis, rules, symbols;
        if (macro.car instanceof ASymbol) {
          ellipsis = macro.car;
          symbols = get_identifiers(macro.cdr.car);
          rules = macro.cdr.cdr;
        } else {
          ellipsis = "...";
          symbols = get_identifiers(macro.car);
          rules = macro.cdr;
        }
        try {
          while (!is_nil(rules)) {
            const rule = rules.car.car;
            let expr = rules.car.cdr.car;
            debug.log("try rule:", rule);
            const bindings = extract_patterns(rule, code, symbols, ellipsis, {
              expansion: this,
              define: env,
              globalEnv: global_env,
            });
            if (bindings) {
              debug.group("match");
              debug.dir(symbolize(bindings));
              debug.log("pattern:", rule);
              debug.log("macro:", code);
              // name is modified in transform_syntax
              const names = [];
              const new_expr = transform_syntax({
                bindings,
                expr,
                symbols,
                scope,
                lex_scope: var_scope,
                names,
                ellipsis,
              });
              debug.log("output:", new_expr);
              debug.groupEnd();
              // TODO: if expression is undefined throw an error
              if (new_expr) {
                expr = new_expr;
              }
              const new_env = var_scope.merge(scope, Syntax.__merge_env__ as unknown as string);
              // FORM-RETURNING (always): hand back the transcribed FORM + its hygiene scope.
              // The evaluator yields this form into the flat trampoline (tail position) and the
              // macroexpand traverse re-expands it — the transformer NEVER evaluates inside
              // itself, so a macro in tail position stays tail-proper (no nested run() frame).
              // restore_data_gensyms un-renames the template's DATA-position gensyms (under
              // quote/quasiquote) so quote yields literal symbols with no post-eval fixup.
              // `macro_expand` no longer changes the return — both callers want the form.
              void macro_expand;
              return { expr: restore_data_gensyms(expr, names), scope: new_env };
            }
            rules = rules.cdr;
          }
        } catch (error_) {
          (error_ as Error).message += `\nin macro:\n  ${macro.toString(true)}`;
          throw error_;
        } finally {
          // Balances `debug.group(code)` opened at entry on every exit path — the two
          // returns and the catch-rethrow all run this; the no-match `throw` below is
          // reached only after `finally`, so its group is already closed.
          debug.timeEnd(trace);
          debug.groupEnd();
        }
        throw new Error(`syntax-rules: no matching syntax in macro ${code.toString(true)}`);
      }, env);
      (syntax as SchemeValue).__code__ = macro;
      return syntax;
    }),
    // ------------------------------------------------------------------
    list: function list(...args) {
      const result = args.reduceRight((list, item) => new APair(CONSTANT_CTX, item, list), nil);
      return withInputProvenance(args, result);
    },
    // ------------------------------------------------------------------
    repr: function repr(obj, quote) {
      return toString(obj, quote);
    },
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // `vector` and `vector-append` live in bridge.ts (wrappedOps), minting boxed
    // SchemeVector. The former stdlib `vector` here was DEAD (initBridge applies
    // wrappedOps over global_env after stdlib builds, so bridge's always won) AND
    // wrong (it typecheck'd args as numbers — non-R7RS). Removed (boxing S7, R11).
    // ------------------------------------------------------------------
    find: function find(arg, list) {
      typecheck("find", arg, ["regex", "function"]);
      typecheck("find", list, ["pair", "nil"]);
      if (is_null(list)) {
        return nil;
      }
      const fn = matcher("find", arg);
      return unpromise(fn(list.car), function (value) {
        if (!is_false(value) && !is_nil(value)) {
          return list.car;
        }
        return find(arg, list.cdr);
      });
    },
    // ------------------------------------------------------------------
    "for-each": function (this: Environment, fn: SchemeFunction, ...lists: SchemeValue[]) {
      typecheck("for-each", fn, "function");
      for (const [i, arg] of lists.entries()) {
        typecheck("for-each", arg, ["pair", "nil"], i + 1);
      }
      // we need to use call(this because babel transpile this code into:
      // var ret = map.apply(void 0, [fn].concat(lists));
      // it don't work with weakBind
      const ret = mapImpl.call(this, fn, ...lists);
      if (is_promise(ret)) {
        return ret.then(() => {});
      }
    },
  } satisfies Record<string, EnvironmentValue>);
export { global_env, user_env as env };

// -------------------------------------------------------------------------
function set_interaction_env(interaction, internal) {
  interaction.constant("**internal-env**", internal);
  interaction.doc(
    "**internal-env**",
    `**internal-env**

         Constant used to hide stdin, stdout and stderr so they don't interfere
         with variables with the same name. Constants are an internal type
         of variable that can't be redefined, defining a variable with the same name
         will throw an error.`,
  );
}

// -------------------------------------------------------------------------
set_interaction_env(user_env, internal_env);

// NOTE: Numeric operations from bridge.ts should be applied by calling initBridge()
// This cannot be done at module load time due to circular dependency
// See: src/bridge.ts initBridge()

// -------------------------------------------------------------------------
// The `:key` keyword accessor — a catchall sibling to c[ad]+r. Registered on
// global_env here (and on the inference env in inference-env.ts). Owned by the
// polyglot capability.
global_env.registerResolver(keywordAccessorResolver);

// -------------------------------------------------------------------------
// `exec` is the single canonical generator-trampoline entry — it lives in
// eval/generator-exec.ts (one bootstrap gate + budget/heap/signal bounds + the
// audit-#42 wrapOperator/TypeError surfacing, all in one place). The old
// stdlib-local `exec`/`exec_with_stacktrace` wrappers — and the legacy recursive
// `evaluate` they once drove — are gone; every evaluation now runs on
// evaluator.ts. Re-exported here so the historical `from "./stdlib"` consumers
// keep resolving.
export { exec } from "./eval/generator-exec.js";

for (const [i, cls] of Object.entries(available_class)) {
  class_map[cls] = +i;
}
// -------------------------------------------------------------------------


// Additional exports needed by Environment.ts
export { eof } from "./values/primitives/EOF.js";

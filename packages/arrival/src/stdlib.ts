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
import { Environment, KEYWORD_ACCESSOR_FIELD } from "./Environment.js";
import { findHeapMeter, heapBudgetMessage } from "./heap-budget.js";
import { eof } from "./values/primitives/EOF.js";
import { AHalfBaked, is_half_baked } from "./values/primitives/AHalfBaked.js";
import { Lexer } from "./reader/Lexer.js";
import { purityDoor } from "./purity.js";
import { Parser } from "./reader/Parser.js";
import { QuotedPromise } from "./values/primitives/QuotedPromise.js";
import {
  is_env,
  is_false,
  is_function,
  is_iterator,
  is_lambda,
  is_native_function,
  is_nil,
  is_null,
  is_pair,
  is_plain_object,
  is_promise,
  is_prototype,
} from "./eval/guards.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { clear_gensyms, extract_patterns, transform_syntax } from "./eval/syntax-rules.js";
import { box, gensym, patch_value, quote } from "./reader/values-repr.js";
import {
  complex_bare_re,
  complex_re,
  float_re,
  int_bare_re,
  int_re,
  parsable_contants,
  rational_bare_re,
  rational_re,
} from "./values/primitives.js";
import { CLASS, SPECULATE } from "./well-known-symbols.js";
import { nil } from "./values/primitives/ANil.js";
import { ACharacter } from "./values/primitives/ACharacter.js";
import * as specials from "./reader/specials.js";
import { call_function } from "./eval/call-function.js";
import { AExact, AInexact } from "./values/numbers.js";
import { type, typecheck, typeErrorMessage } from "./utils/typecheck.js";
import { parse_complex, parse_float, parse_integer, parse_rational } from "./utils/parsing.js";
import { Values } from "./values/primitives/Values.js";
import { available_class, class_map } from "./reader/serialize.js";
import { Macro } from "./eval/Macro.js";
import { Syntax } from "./eval/Syntax.js";
import { isCircularList, APair, concatPair } from "./values/primitives/APair.js";
import { promise_all, unpromise } from "./utils/promises.js";
import { curry } from "./utils/functional.js";

import { ABool } from "./values/primitives/ABool.js";
import { ABytevector } from "./values/primitives/ABytevector.js";
import { AString } from "./values/primitives/AString.js";
import { AVector } from "./values/primitives/AVector.js";
import {
  keywordAccessorResolver,
  NOT_FOUND,
  accessMember,
  InteropAccessError,
} from "./membrane.js";
import { AJSObject } from "./values/primitives/js-wrappers.js";
import { collapseProvenance, taintString } from "./provenance-collapse.js";
import genRun, { type EvalContext, currentRunEnv, evaluate as genEvaluate, isSpeculating, SchemeError } from "./eval/evaluator.js";


// Type definitions for dynamic Scheme values
// Scheme is inherently dynamic - these use `any` intentionally for interpreter interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeValue = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemeFunction = (...args: any[]) => any;

let env: Environment;
// -------------------------------------------------------------------------

// Structured tracer for the syntax-rules expander, gated by the Scheme `DEBUG`
// variable (`(define DEBUG #t)` to enable; `(define DEBUG n)` to enable only the
// `enabled(n)` channel). Inert when off — every method short-circuits before
// touching the console. Mirrors the native console API so traces NEST
// (group/groupEnd) and are TIMED (time/timeEnd) rather than flat spew; `dir`
// renders the binding maps with full depth. JS-string args are treated as labels
// (passed through); SchemeValues are formatted via `toString`/`map_object`.
/* c8 ignore start */
let debugSeq = 0;
const debug = {
  enabled(n: SchemeValue = null): boolean {
    const flag = user_env?.get("DEBUG", { throwError: false });
    if (n === null) {
      return !is_false(flag);
    }
    return flag?.valueOf() === n.valueOf();
  },
  fmt(x: SchemeValue): unknown {
    return typeof x === "string"
      ? x
      : is_plain_object(x)
        ? map_object(x, (value: SchemeValue) => toString(value, true))
        : toString(x, true);
  },
  log(...args: SchemeValue[]): void {
    if (this.enabled()) console.log(...args.map((a) => this.fmt(a)));
  },
  dir(x: unknown): void {
    if (this.enabled()) console.dir(x, { depth: null });
  },
  group(label: SchemeValue): void {
    if (this.enabled()) console.group(this.fmt(label));
  },
  groupEnd(): void {
    if (this.enabled()) console.groupEnd();
  },
  time(label: string): void {
    if (this.enabled()) console.time(label);
  },
  timeEnd(label: string): void {
    if (this.enabled()) console.timeEnd(label);
  },
};
/* c8 ignore stop */

// ----------------------------------------------------------------------
function tokens(str: SchemeValue): SchemeValue[] {
  if (str instanceof AString) {
    str = str.valueOf();
  }
  const lexer = new Lexer(str, { whitespace: true });
  const result: SchemeValue[] = [];
  while (true) {
    const token = lexer.peek(true);
    if (token === eof) {
      break;
    }
    result.push(token);
    lexer.skip();
  }
  return result;
}

// ----------------------------------------------------------------------
export function tokenize(str: string | AString, meta = false) {
  if (str instanceof AString) {
    str = str.toString();
  }
  if (meta) {
    return tokens(str);
  } else {
    const result = tokens(str)
      .map(function (token) {
        // we don't want literal space character to be trimmed
        if (token.token === String.raw`#\ ` || token.token == "#\\\n") {
          return token.token;
        }
        return token.token.trim();
      })
      .filter(function (token) {
        return token && !token.startsWith(";") && !/^#\|[\s\S]*\|#$/.test(token);
      });
    return strip_s_comments(result);
  }
}

// ----------------------------------------------------------------------
function strip_s_comments(tokens: string[]): string[] {
  let s_count = 0;
  let s_start: number | null = null;
  const remove_list: [number, number][] = [];
  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (token === "#;") {
      if (["(", "["].includes(tokens[i + 1])) {
        s_count = 1;
        s_start = i;
      } else {
        remove_list.push([i, i + 2]);
      }
      i += 1;
      continue;
    }
    if (s_start !== null) {
      if ([")", "]"].includes(token)) {
        s_count--;
      } else if (["(", "["].includes(token)) {
        s_count++;
      }
      if (s_count === 0) {
        remove_list.push([s_start, i + 1]);
        s_start = null;
      }
    }
  }
  tokens = [...tokens];
  remove_list.reverse();
  for (const [begin, end] of remove_list) {
    tokens.splice(begin, end - begin);
  }
  return tokens;
}

// Helper functions used by gensym - imported types have their own copies
function symbol_to_string(obj: SchemeValue): string {
  return obj.toString().replace(/^Symbol\(([^)]+)\)/, "$1");
}

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
async function* _parse(arg: SchemeValue, env?: Environment, source?: string) {
  if (!env) {
    env = user_env;
  }
  let parser;
  if (arg instanceof Parser) {
    parser = arg;
  } else {
    parser = new Parser({ env, source });
    parser.parse(arg);
  }
  let prev;
  while (true) {
    const expr = await parser.read_object();
    if (!parser.balanced()) {
      parser.ballancing_error(expr, prev);
    }
    if (expr === eof) {
      break;
    }
    prev = expr;
    yield expr;
  }
}

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
// :: Sets __name__ on functions for Scheme representation
// :: Needed because Scheme names (empty?, set-car!) aren't valid JS identifiers
// ----------------------------------------------------------------------
export function doc(name: string | null, fn: SchemeValue, docstring?: string) {
  if (name) {
    fn.__name__ = name;
  } else if (fn.name && !is_lambda(fn)) {
    fn.__name__ = fn.name;
  }
  if (docstring) {
    fn.__doc__ = docstring;
  }
  return fn;
}

/**
 * Mark a builtin as understanding a `HalfBaked` arg (Tier 2 speculative
 * evaluation). The dispatch choke (evaluator.ts) skips forcing the args of a
 * marked callable, so the builtin reads the lazy carrier itself (its cardinality
 * interval) instead of receiving a settled value. Only `length` and the
 * comparison ops are marked; everything else gets force-on-unknown-boundary.
 */
function speculative<T>(fn: T): T {
  (fn as { [SPECULATE]?: boolean })[SPECULATE] = true;
  return fn;
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
          throw new SchemeError(heapBudgetMessage(meter.max), []);
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

const repr = new Map();

// ----------------------------------------------------------------------
const props = Object.getOwnPropertyNames(Array.prototype);
const array_methods: SchemeValue[] = [];
for (const x of props) {
  array_methods.push((Array as SchemeValue)[x], Array.prototype[x as keyof typeof Array.prototype]);
}

// ----------------------------------------------------------------------
function user_repr(obj) {
  const constructor = obj.constructor || Object;
  const plain_object = is_plain_object(obj);
  const iterator = is_function(obj[Symbol.asyncIterator]) || is_function(obj[Symbol.iterator]);
  let fn;
  if (repr.has(constructor)) {
    fn = repr.get(constructor);
  } else {
    for (const [key, value] of repr.entries()) {
      // if key is Object it should only work for plain_object
      // because otherwise it will match every object
      // we don't use instanceof so it don't work for subclasses
      if (constructor === key && ((key === Object && plain_object && !iterator) || key !== Object)) {
        fn = value;
      }
    }
  }
  return fn;
}

// ----------------------------------------------------------------------
const str_mapping = new Map();
for (const [key, value] of [
  [true, "#t"],
  [false, "#f"],
  [null, "#null"],
  [undefined, "#void"],
]) {
  str_mapping.set(key, value);
}
// ----------------------------------------------------------------------
// :: Debug function that can be used with JSON.stringify
// :: that will show symbols
// ----------------------------------------------------------------------
/* c8 ignore next 22 */
function symbolize(obj) {
  if (obj && typeof obj === "object") {
    const result = {};
    const symbols = Object.getOwnPropertySymbols(obj);
    for (const key of symbols) {
      const name = key.toString().replace(/Symbol\(([^)]+)\)/, "$1");
      result[name] = toString(obj[key]);
    }
    const props = Object.getOwnPropertyNames(obj);
    for (const key of props) {
      const o = obj[key];
      result[key] = o && typeof o === "object" && o.constructor === Object ? symbolize(o) : toString(o);
    }
    return result;
  }
  return obj;
}

// ----------------------------------------------------------------------
export function get_props(obj: object): (string | symbol)[] {
  return (Object.keys(obj) as (string | symbol)[]).concat(Object.getOwnPropertySymbols(obj));
}

// ----------------------------------------------------------------------
function has_own_function(obj, name) {
  return obj.hasOwnProperty(name) && is_function(obj.toString);
}

// ----------------------------------------------------------------------
function function_to_string(fn) {
  if (is_native_function(fn)) {
    return "#<procedure(native)>";
  }
  if (fn.hasOwnProperty("__name__")) {
    let name = fn.__name__;
    if (typeof name === "symbol") {
      name = symbol_to_string(name);
    }
    if (typeof name === "string") {
      return `#<procedure:${name}>`;
    }
  }
  if (has_own_function(fn, "toString")) {
    return fn.toString();
  } else if (fn.name && !is_lambda(fn)) {
    return `#<procedure:${fn.name.trim()}>`;
  } else {
    return "#<procedure>";
  }
}

// ----------------------------------------------------------------------
// Instances extracted to make cyclomatic complexity of toString smaller
let _instances: Map<any, Function> | null = null;
function get_instances() {
  if (!_instances) {
    _instances = new Map();
    for (const [cls, fn] of [
      [
        Error,
        function (e: Error) {
          return e.message;
        },
      ],
      [
        APair,
        function (pair: APair, { quote, skip_cycles, pair_args }: any) {
          // make sure that repr directly after update set the cycle ref
          if (!skip_cycles) {
            pair.mark_cycles();
          }
          return pair.toString(quote, ...pair_args);
        },
      ],
      [
        ACharacter,
        function (chr: ACharacter, { quote }: any) {
          if (quote) {
            return chr.toString();
          }
          return chr.valueOf();
        },
      ],
      [
        AString,
        function (str: AString, { quote }: any) {
          const strVal = str.toString();
          if (quote) {
            return JSON.stringify(strVal).replaceAll(String.raw`\n`, "\n");
          }
          return strVal;
        },
      ],
      [
        RegExp,
        function (re: RegExp) {
          return `#${re.toString()}`;
        },
      ],
      [
        // Boxed vectors render as their R7RS external representation #(...),
        // recursing through `toString` so nested vectors/strings format correctly
        // and `quote` propagates. (Without this they fell through to the generic
        // #<__class__> / #<JS-class-name> garbage — the only user-facing stringify
        // in the MCP bridge env. Cyclic vectors are not datum-labeled here; repr
        // of a runtime-cyclic vector is a known gap, as for cyclic data generally.)
        AVector,
        function (vec: AVector, { quote }: any) {
          return `#(${vec.__vector__.map((el) => toString(el, quote)).join(" ")})`;
        },
      ],
      [
        ABytevector,
        function (bv: ABytevector) {
          return `#u8(${Array.from(bv.__bytevector__).join(" ")})`;
        },
      ],
    ]) {
      _instances.set(cls, fn);
    }
  }
  return _instances;
}
// ----------------------------------------------------------------------
let _native_types: any[] | null = null;
function get_native_types() {
  if (!_native_types) {
    _native_types = [ASymbol, Macro, Values, Environment, QuotedPromise];
  }
  return _native_types;
}

// ----------------------------------------------------------------------
function toString(obj: unknown, quote = false, skip_cycles = false, ...pair_args: unknown[]): string {
  if (str_mapping.has(obj)) {
    return str_mapping.get(obj);
  }
  if (is_prototype(obj)) {
    return "#<prototype>";
  }
  if (obj) {
    const cls = obj.constructor;
    const instances = get_instances();
    if (instances.has(cls)) {
      return instances.get(cls)!(obj, { quote, skip_cycles, pair_args });
    }
  }
  // standard objects that have toString
  for (const type of get_native_types()) {
    if (obj instanceof type) {
      return (obj as SchemeValue).toString(quote);
    }
  }
  if (obj instanceof AExact || obj instanceof AInexact) {
    return obj.toString();
  }
  // constants
  if ([nil, eof].includes(obj as typeof nil)) {
    return (obj as SchemeValue).toString();
  }
  if (obj === globalThis) {
    return "#<js:global>";
  }
  if (obj === null) {
    return "null";
  }
  if (is_function(obj)) {
    if (is_function(obj.toString) && obj.hasOwnProperty("toString")) {
      // promises
      return obj.toString().valueOf();
    }
    return function_to_string(obj);
  }
  if (typeof obj === "object") {
    let constructor = obj.constructor;
    if (!constructor) {
      // This is case of fs.constants in Node.js that is null constructor object.
      // This object can be handled like normal objects that have properties
      constructor = Object;
    }
    let name;
    if (typeof (constructor as SchemeValue)[CLASS] === "string") {
      name = (constructor as SchemeValue)[CLASS];
    } else {
      const fn = user_repr(obj);
      if (fn) {
        invariant(is_function(fn), "toString: Invalid repr value");
        return fn(obj, quote);
      }
      name = constructor.name;
    }
    // user defined representation
    if (is_function(obj.toString) && obj.hasOwnProperty("toString")) {
      return obj.toString().valueOf();
    }
    if (type(obj) === "instance") {
      if (is_lambda(constructor) && (constructor as SchemeValue).__name__) {
        name = (constructor as SchemeValue).__name__.valueOf();
        if (typeof name === "symbol") {
          name = name.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1");
        }
      } else if (!is_native_function(constructor)) {
        name = "instance";
      }
    }
    if (is_iterator(obj, Symbol.iterator)) {
      if (name) {
        return `#<iterator(${name})>`;
      }
      return "#<iterator>";
    }
    if (is_iterator(obj, Symbol.asyncIterator)) {
      if (name) {
        return `#<asyncIterator(${name})>`;
      }
      return "#<asyncIterator>";
    }
    if (name !== "") {
      return `#<${name}>`;
    }
    return "#<Object>";
  }
  if (obj != null && typeof obj !== "string") {
    return obj.toString();
  }
  return obj ?? "";
}

// ----------------------------------------------------------------------
// eq/eqv moved to structural-equal.ts; the macro engine (macro_expand /
// extract_patterns / clear_gensyms / transform_syntax / self_evaluated)
// moved to syntax-rules.ts (keystone K3) and is imported above.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// :: Function utilities
// ----------------------------------------------------------------------
// box() relocated to reader/values-repr.ts (the value-representation leaf,
// alongside quote/patch_value); imported above. Re-exported below for the barrel.

// ----------------------------------------------------------------------
function map_object(object, fn) {
  const props = Object.getOwnPropertyNames(object);
  const symbols = Object.getOwnPropertySymbols(object);
  const result = {};
  for (const key of [...props, ...symbols]) {
    result[key] = fn(object[key]);
  }
  return result;
}

// ----------------------------------------------------------------------
function unbox(object) {
  const is_boxed_primitive =
    object instanceof AString ||
    object instanceof ACharacter ||
    object instanceof AExact ||
    object instanceof AInexact;
  if (is_boxed_primitive) {
    return object.valueOf();
  }
  if (object instanceof AVector) {
    return object.__vector__.map(unbox);
  }
  if (object instanceof ABytevector) {
    return object.__bytevector__;
  }
  if (Array.isArray(object)) {
    return object.map(unbox);
  }
  if (object instanceof QuotedPromise) {
    delete (object as SchemeValue).then;
  }
  if (is_plain_object(object)) {
    return map_object(object, unbox);
  }
  return object;
}

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
export const get = doc("get", function get(object, ...args) {
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
});
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
const nan = new AInexact(CONSTANT_CTX, Number.NaN);
const constants = {
  "#t": true,
  "#f": false,
  "#true": true,
  "#false": false,
  "+inf.0": Number.POSITIVE_INFINITY,
  "-inf.0": Number.NEGATIVE_INFINITY,
  "+nan.0": nan,
  "-nan.0": nan,
  ...parsable_contants,
};

const is_node = () => typeof process === "object" && !!process.env;

// -------------------------------------------------------------------------
// :: Thin wrapper: delegates a special form to the generator evaluator.
// :: LIPS evaluate dispatches to these Macros, which hand off to the
// :: generator's evaluate + run. This lets us delete the complex,
// :: poorly-typed LIPS Macro implementations for forms the generator
// :: already handles correctly.
// -------------------------------------------------------------------------
function genMacroWrapper(name: string): Macro {
  return new Macro(name, function (this: Environment, code: SchemeValue, options: SchemeValue = {}) {
    const form = new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, name), code);
    const ctx: EvalContext = {
      env: this,
      dynamic_env: options.dynamic_env ?? this,
      use_dynamic: options.use_dynamic,
    };
    // Quote Pair results so evaluate_macro doesn't re-evaluate them as code.
    // The LIPS evaluator checks __data__ flag — without it, a Pair like
    // (list "a" "b") would be treated as a function call ("a" "b").
    return genRun(genEvaluate(form, ctx)).then((value: SchemeValue) => {
      if (is_pair(value)) {
        value.mark_cycles();
        return quote(value);
      }
      return value;
    });
  });
}

// -------------------------------------------------------------------------
export const global_env = new Environment(
  "global",
  {
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
    dict: doc("dict", function dict(...args: SchemeValue[]) {
      const obj: Record<string, SchemeValue> = {};
      for (let i = 0; i + 1 < args.length; i += 2) {
        const k = args[i] as { [KEYWORD_ACCESSOR_FIELD]?: string } | null;
        const key =
          (k != null && (typeof k === "function" || typeof k === "object") && k[KEYWORD_ACCESSOR_FIELD]) ||
          String(args[i]).replace(/^:/, "");
        obj[key] = args[i + 1];
      }
      return obj;
    }),
    // ------------------------------------------------------------------
    // set-car! / set-cdr! / append! — OMITTED by the purity invariant (every
    // entity is frozen by design). Doored in core.ts. See plan-2026-06-11.
    // set! / do / if / letrec / letrec* / let* / let / begin / parameterize —
    // VESTIGIAL global_env registrations of forms the evaluator's SPECIAL_FORMS
    // table already shadows before env lookup (parameterize is doored in core.ts).
    // Deleted: no first-class lookup reaches them, and macro_expand's traverse
    // only special-cases `lambda`/`define` by identity (the `let` family by name),
    // so the bindings are unreferenced. See husk-dissolution pass.
    // ------------------------------------------------------------------
    gensym: doc("gensym", gensym),
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // %purity-door — the ONE host primitive behind every omitted feature.
    // arrival's omission boundary (dynamics + writing methods) is declared in
    // core.ts as a manifesto of `define-macro` doors that all call this.
    // It throws the typed PurityError (feature/owner code → follow-rate
    // telemetry, errors-as-doors Rule 3/5); the language owns the LIST, the host
    // owns the typed throw. See docs/plan-2026-06-11-purity-pass.md.
    "%purity-door": doc(null, function (feature: unknown, reason: unknown, alternative: unknown) {
      const s = (v: unknown) => String((v as { valueOf?: () => unknown })?.valueOf?.() ?? v);
      purityDoor(s(feature), s(reason), s(alternative));
    }),
    // ------------------------------------------------------------------
    // define delegates to the generator evaluator (evalDefine) via
    // genMacroWrapper. Verified empirically equivalent to the old defmacro on
    // every reachable case (fn-shorthand + recursion, symbol alias, define in
    // let/begin, macroexpand round-trip; full suite green). Three legacy-only
    // behaviors are NOT ported because they are unreachable through the
    // current macro engine, so no test can exercise them: (1) the
    // Syntax.__merge_env__ parent-env redirect — only fires when a syntax-rules
    // template introduces a define, but expansion dies upstream at pattern
    // matching first; (2) the macroexpand guard — macroexpand already returns
    // the form inert without executing it; (3) __name__ stamping on
    // Syntax/Parameter values (not just lambdas) — cosmetic introspection.
    // If the macro engine later gains macro-introduced-define support, add the
    // hygiene redirect to evalDefine WITH a test that actually reaches it.
    define: genMacroWrapper("define"),
    // ------------------------------------------------------------------
    // lambda delegates to the generator (evalLambda via SPECIAL_FORMS); the
    // binding exists for first-class lookup + the macro engine's identity check
    // (`value === env.get("lambda")` in syntax-rules.ts), like define/let/if.
    lambda: genMacroWrapper("lambda"),
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
      const syntax = new Syntax(function (this: Environment, code: SchemeValue, { macro_expand }: SchemeValue) {
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
              if (macro_expand) {
                return { expr, scope: new_env };
              }
              // Drain: evaluate the expanded template through the generator. This
              // is the last reachable legacy-evaluate caller. The Syntax transformer's
              // return value IS the final result (the generator awaits this promise
              // before returning the syntax expansion), so going async is transparent.
              // clear_gensyms runs on the resolved result (gensym→literal-symbol fixup).
              return unpromise(genRun(genEvaluate(expr, { ...eval_args, env: new_env })), (result: SchemeValue) =>
                // Hack: update the result if there are generated
                //       gensyms that should be literal symbols
                clear_gensyms(result, names),
              );
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
    list: doc("list", function list(...args) {
      const result = args.reduceRight((list, item) => new APair(CONSTANT_CTX, item, list), nil);
      return withInputProvenance(args, result);
    }),
    // ------------------------------------------------------------------
    repr: doc("repr", function repr(obj, quote) {
      return toString(obj, quote);
    }),
    // ------------------------------------------------------------------
    typecheck: doc(null, typecheck),
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // `vector` and `vector-append` live in bridge.ts (wrappedOps), minting boxed
    // SchemeVector. The former stdlib `vector` here was DEAD (initBridge applies
    // wrappedOps over global_env after stdlib builds, so bridge's always won) AND
    // wrong (it typecheck'd args as numbers — non-R7RS). Removed (boxing S7, R11).
    // ------------------------------------------------------------------
    length: speculative(
      doc("length", function length(obj) {
        if (!obj || is_nil(obj)) {
          return 0;
        }
        // Tier 2 speculation: length of a still-filling collection is its narrowing
        // cardinality INTERVAL, surfaced as a number-domain HalfBaked that the
        // comparison ops read for early collapse. Reached only when speculation is
        // on (the choke leaves a HalfBaked unforced solely for this marked op).
        if (is_half_baked(obj)) {
          return obj.toCardinalityNumber();
        }
        if (is_pair(obj)) {
          TypeError.invariant(!isCircularList(obj), "length: circular list");
          return withInputProvenance([obj], obj.length());
        }
        if ("length" in obj) {
          return withInputProvenance([obj], obj.length);
        }
      }),
    ),
    // ------------------------------------------------------------------
    find: doc("find", function find(arg, list) {
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
    }),
    // ------------------------------------------------------------------
    "for-each": doc("for-each", function (this: Environment, fn: SchemeFunction, ...lists: SchemeValue[]) {
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
    }),
    // ------------------------------------------------------------------
    map: doc("map", mapImpl),
    // ------------------------------------------------------------------
    filter: doc("filter", function filter(this: Environment, arg, list) {
      typecheck("filter", arg, ["regex", "function"]);
      typecheck("filter", list, ["pair", "nil"]);
      // `to_array` finds this run's heap meter via the evaluator's run-scoped
      // `currentRunEnv()` (set at the apply boundary), so no env threading is needed here.
      const array = listToArray(list);
      if (array.length === 0) {
        return nil;
      }
      const fn = matcher("filter", arg);

      // Call predicate on all elements in parallel
      const predicateResults = array.map((item) => fn(item));
      const hasPromises = predicateResults.some(is_promise);

      // `is_false` rather than raw `!r`: post-Option-C, predicates can return
      // SchemeBool wrappers (e.g. `:active` on a SchemeJSObject yields a
      // boxed boolean carrying container provenance). Raw `&&` treats any
      // object as truthy and would retain false-valued entries.

      // Tier-2 speculation: when the predicate fan is still filling AND the
      // caller opted in, return a lazy `HalfBaked` collection instead of
      // awaiting `promise_all`. Each slot resolves to the items it contributes
      // ([] dropped, [item] kept), so the cardinality interval narrows from both
      // ends as slots settle — letting `(>= (length …) k)` collapse the instant
      // lo reaches k, with the rest of the fan still pending. Bounds [0,1] per
      // slot (a predicate keeps at most one). Forced back to a Pair (identical
      // to the eager result) at any non-speculating boundary. EMPTY_PROVENANCE:
      // filter doesn't union container provenance on the eager path either.
      if (hasPromises && isSpeculating()) {
        const slots = predicateResults.map((r, i) => {
          const keep = (verdict: unknown): SchemeValue[] => (!is_false(verdict) && !is_nil(verdict) ? [array[i]] : []);
          return is_promise(r) ? (r as Promise<unknown>).then(keep) : Promise.resolve(keep(r));
        });
        return AHalfBaked.collection(ctxOf(list), slots, () => [0, 1]);
      }
      if (hasPromises) {
        return (promise_all(predicateResults) as Promise<unknown[]>).then((results) => {
          const filtered = array.filter((_, i) => !is_false(results[i]) && !is_nil(results[i]));
          return APair.fromArray(ctxOf(list), filtered);
        });
      }
      const filtered = array.filter((_, i) => !is_false(predicateResults[i]) && !is_nil(predicateResults[i]));
      return APair.fromArray(ctxOf(list), filtered);
    }),
    // ------------------------------------------------------------------
    curry: doc(null, curry),
  },
  undefined,
);
const user_env = global_env.inherit("user-env");
export { user_env as env };

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

// unwrap async generator into Promise<Array>
export const parse = async (arg: SchemeValue, env?: Environment, source?: string) => {
  const result: SchemeValue[] = [];
  for await (const item of _parse(arg, env, source)) {
    result.push(item);
  }
  return result;
};

// Additional exports needed by Environment.ts
export { eof } from "./values/primitives/EOF.js";

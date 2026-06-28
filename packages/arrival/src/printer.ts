// The value → string printer for arrival SchemeValues — `toString` plus its
// repr registry and the value-unwrap helpers. This is the package's display /
// `write` representation of any value, the inverse of the reader.
//
// Extracted from the stdlib monolith (the since-split lips.ts). It sits at a
// HIGH layer: to print any value it must know every printable type — not only
// the value classes (AString/APair/AVector/…) but the eval-world classes
// (Environment, Macro, Values). So this is a top-level module beside stdlib, NOT
// a `values/` leaf — `values/` stays Environment/Macro-free (cf.
// values/structural-equal.ts). Nothing in the value/eval/env layers imports the
// printer — only stdlib does — so it introduces no import cycle, and it was
// never exported from the package, so it carries no public-barrel obligation.
//
// The four functions stdlib's builtins/tracer still call are exported
// (toString / unbox / map_object / symbolize); the repr registry helpers stay
// module-private.
// ----------------------------------------------------------------------
import invariant from "tiny-invariant";
import { Environment } from "./Environment.js";
import { eof } from "./values/primitives/EOF.js";
import { QuotedPromise } from "./values/primitives/QuotedPromise.js";
import {
  is_function,
  is_lambda,
  is_native_function,
  is_plain_object,
} from "./eval/guards.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { CLASS } from "./well-known-symbols.js";
import { nil } from "./values/primitives/ANil.js";
import { ACharacter } from "./values/primitives/ACharacter.js";
import { AExact, AInexact } from "./values/numbers.js";
import { type } from "./utils/typecheck.js";
import { Values } from "./values/primitives/Values.js";
import { Macro } from "./eval/Macro.js";
import { APair } from "./values/primitives/APair.js";
import { ABytevector } from "./values/primitives/ABytevector.js";
import { AString } from "./values/primitives/AString.js";
import { AVector } from "./values/primitives/AVector.js";
import type { SchemeValue } from "./values/types.js";

// Renders a Symbol's description: strips the `Symbol(...)` wrapper. Used by
// function_to_string for symbol-named procedures.
function symbol_to_string(obj: SchemeValue): string {
  return obj.toString().replace(/^Symbol\(([^)]+)\)/, "$1");
}

// ----------------------------------------------------------------------
// User-registered per-constructor repr functions. A LIPS extension point
// (never populated in the inference plane), kept so `toString`'s object branch
// keeps its original fall-through shape.
const repr = new Map();

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
export function symbolize(obj) {
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
export function toString(obj: unknown, quote = false, skip_cycles = false, ...pair_args: unknown[]): string {
  if (str_mapping.has(obj)) {
    return str_mapping.get(obj);
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
export function map_object(object, fn) {
  const props = Object.getOwnPropertyNames(object);
  const symbols = Object.getOwnPropertySymbols(object);
  const result = {};
  for (const key of [...props, ...symbols]) {
    result[key] = fn(object[key]);
  }
  return result;
}

// ----------------------------------------------------------------------
export function unbox(object) {
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

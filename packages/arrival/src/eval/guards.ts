import { Environment } from "../Environment.js";
import { ABool } from "../values/primitives/ABool.js";
import { Macro } from "./Macro.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { Syntax } from "./Syntax.js";
import {
  char_re,
  complex_re,
  directives,
  float_re,
  int_re,
  rational_re,
  re_re,
} from "../values/primitives.js";
import * as specials from "../reader/specials.js";
import { nil } from "../values/primitives/ANil.js";
// Leaf value-kernel predicates live in value-guards.ts (no Environment/Macro
// dep) so Pair.ts can import them without dragging the evaluator world in.
// Re-exported here so every existing `from "./guards.js"` call site is unchanged.
import { is_function, is_nil } from "../values/value-guards.js";

export {
  has_own_symbol,
  is_function,
  is_instance,
  is_iterator,
  is_native,
  is_nil,
  is_pair,
  is_plain_object,
} from "../values/value-guards.js";

// Import directly from source files to avoid circular dependency with lips.ts

export function is_int(value: unknown): value is number {
  return typeof value === "number" && Number.parseInt(value.toString(), 10) === value;
}

// ----------------------------------------------------------------------
function is_atom_string(str: string): boolean {
  return !(["(", ")", "[", "]"].includes(str) || specials.names().includes(str));
}

// ----------------------------------------------------------------------
export function is_symbol_string(str: unknown): str is string {
  if (typeof str !== "string") return false;
  return (
    is_atom_string(str) &&
    !(
      re_re.test(str) ||
      /^"[\s\S]*"$/.test(str) ||
      str.match(int_re) ||
      float_re.test(str) ||
      str.match(complex_re) ||
      str.match(rational_re) ||
      char_re.test(str) ||
      ["#t", "#f", "nil"].includes(str)
    )
  );
}

export function is_special(token: unknown): boolean {
  return typeof token === "string" && specials.names().includes(token);
}

export function is_vector_literal(token: unknown): token is "#(" {
  return token === "#(";
}

export function is_bytevector_literal(token: unknown): token is "#u8(" {
  return token === "#u8(";
}

export function is_builtin(token: unknown): boolean {
  return typeof token === "string" && specials.__builtins__.includes(token);
}

export function is_literal(special: unknown): boolean {
  return typeof special === "string" && specials.type(special) === specials.LITERAL;
}

export function is_symbol_extension(special: unknown): boolean {
  return typeof special === "string" && specials.type(special) === specials.SYMBOL;
}
// ----------------------------------------------------------------------
// :: Check for nullish values
// ----------------------------------------------------------------------
export function is_null(value: unknown): value is null | undefined | typeof nil {
  return is_undef(value) || is_nil(value) || value === null;
}

// ----------------------------------------------------------------------------
export function is_directive(token: unknown): boolean {
  return typeof token === "string" && directives.includes(token);
}

// ----------------------------------------------------------------------------
export function is_false(o: unknown): o is false | null | ABool {
  switch (true) {
    case o === false:
    case o === null:
      return true;
    case o instanceof ABool:
      return o.value === false;
    default:
      return false;
  }
}

// ----------------------------------------------------------------------------
export function is_string(o: unknown): o is string {
  return typeof o === "string";
}

// ----------------------------------------------------------------------------
export function is_prototype(obj: unknown): boolean {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "constructor" in obj &&
    typeof obj.constructor === "function" &&
    obj.constructor.prototype === obj
  );
}

// ----------------------------------------------------------------------
export function is_env(o: unknown): o is Environment {
  return o instanceof Environment;
}

// ----------------------------------------------------------------------
// `Macro | Syntax`: since Syntax no longer extends Macro, both arms are listed
// explicitly (plus the SRFI-139 Syntax.Parameter). The evaluator's expand hook
// narrows on this then on `is_syntax` — see evaluator.ts.
export function is_macro(o: unknown): o is Macro | Syntax {
  return o instanceof Macro || o instanceof Syntax || o instanceof Syntax.Parameter;
}

// ----------------------------------------------------------------------
export function is_syntax(o: unknown): o is Syntax {
  return o instanceof Syntax;
}

// ----------------------------------------------------------------------
export function is_promise(o: unknown): o is Promise<unknown> {
  if (o instanceof Promise) {
    return true;
  }
  return !!o && typeof o === "object" && "then" in o && is_function(o.then);
}

export function is_undef(value: unknown): value is undefined {
  return value === undefined;
}

// ----------------------------------------------------------------------
// A procedure: a JS function (a Scheme lambda carries the LAMBDA brand; native builtins / rosettas
// are bare functions) or a macro. There is no borrowed-JS-function wrapper anymore — the membrane
// materializes a borrowed JS function to #void (uncallable), so the old `is_js_function_wrapper`
// disjunct (a duck-type check for the deleted AJSFunction "js-function" tag — always false once the
// class was removed) is gone with it.
export function is_callable(o: unknown): boolean {
  return is_function(o) || is_macro(o);
}

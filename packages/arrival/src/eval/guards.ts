import { Macro } from "./Macro.js";
import { Syntax } from "./Syntax.js";
// Leaf value-kernel predicates live in value-guards.ts (no AmbientRuntime/Macro
// dep) so Pair.ts can import them without dragging the evaluator world in.
// Re-exported here so every existing `from "./guards.js"` call site is unchanged.
import { is_function, is_callable_value } from "../values/value-guards.js";

export {
  has_own_symbol,
  is_false,
  is_function,
  is_iterator,
  is_native,
  is_nil,
  is_plain_object,
} from "../values/value-guards.js";

export function is_int(value: unknown): value is number {
  return typeof value === "number" && Number.parseInt(value.toString(), 10) === value;
}

// ----------------------------------------------------------------------
// `Macro | Syntax`: since Syntax no longer extends Macro, both arms are listed
// explicitly (plus the SRFI-139 Syntax.Parameter). The evaluator's expand hook
// narrows on this then on `instanceof Syntax` — see evaluator.ts.
export function is_macro(o: unknown): o is Macro | Syntax {
  return o instanceof Macro || o instanceof Syntax || o instanceof Syntax.Parameter;
}

// ----------------------------------------------------------------------
export function is_promise(o: unknown): o is Promise<unknown> {
  if (o instanceof Promise) {
    return true;
  }
  return !!o && typeof o === "object" && "then" in o && is_function(o.then);
}

// ----------------------------------------------------------------------
// A procedure: a JS function (native builtins / rosettas are bare functions; a Scheme
// lambda is a real ALambda value — see is_callable_value — not a branded bare function,
// the LAMBDA Symbol.for brand was retired, see well-known-symbols.ts) or a macro. There
// is no borrowed-JS-function wrapper — the membrane materializes a borrowed JS function
// to #void (uncallable).
export function is_callable(o: unknown): boolean {
  return is_function(o) || is_macro(o) || is_callable_value(o);
}

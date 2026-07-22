import { Macro } from "./Macro.js";
import { Syntax } from "./Syntax.js";
import { TF_EXPAND } from "../values/tagless-final.js";
// Leaf value-kernel predicates live in value-guards.ts (no AmbientRuntime/Macro dep) so
// Pair.ts can import them without pulling in the evaluator world; re-exported here so a
// `from "./guards.js"` call site resolves them unchanged.
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

// Syntax does not extend Macro, so both arms are listed explicitly (plus the SRFI-139
// Syntax.Parameter). The evaluator's expand hook narrows on this, then on `instanceof
// Syntax` — see evaluator.ts.
export function is_macro(o: unknown): o is Macro | Syntax {
  return o instanceof Macro || o instanceof Syntax || o instanceof Syntax.Parameter;
}

// Structural RAW-ARG discipline: any head carrying the `TF_EXPAND` term (a `Macro` or a
// `Syntax`) — the expand-time counterpart to `is_applyable`'s EVAL-ARG `tf("apply")` check.
// The head gate dispatches on THIS, not on `instanceof Macro | Syntax`, so a value's calling
// discipline travels with the value's terms, not its class. (`Syntax.Parameter`, the SRFI-139
// wrapper, carries no term and is not a call head — it falls through to the non-callable door,
// as it always structurally should.)
export function is_expandable(o: unknown): o is Macro | Syntax {
  return typeof (o as Record<PropertyKey, unknown> | null | undefined)?.[TF_EXPAND] === "function";
}

export function is_promise(o: unknown): o is Promise<unknown> {
  if (o instanceof Promise) {
    return true;
  }
  return !!o && typeof o === "object" && "then" in o && is_function(o.then);
}

// A procedure: a JS function (native builtins / rosettas are bare functions; a Scheme
// lambda is an ALambda value — see is_callable_value — never a branded bare function) or
// a macro. No borrowed-JS-function wrapper exists — docs/membrane.md §VOID-RULE.
// `is_function(o) ||` is the bare-fn survivor arm — a P1 membrane-leak witness; retires
// when raw fns leave env value space.
export function is_callable(o: unknown): boolean {
  return is_function(o) || is_macro(o) || is_callable_value(o);
}

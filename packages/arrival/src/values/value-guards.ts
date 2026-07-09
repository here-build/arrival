// Leaf value-kernel predicates.
//
// These type guards depend ONLY on the value kernel (Pair, Nil, the native
// scalar wrappers) — never on Environment / Macro / Syntax. Carved out of
// guards.ts (a *false leaf* that imports Environment, Macro, …) so Pair.ts can
// import the predicates it needs without dragging the evaluator world into
// the value kernel. guards.ts re-exports them for backward compatibility.
//
// The residual Pair <-> value-guards 2-cycle is intentional and harmless: both
// live inside the future @arrival/values package, so the cross-package
// dependency graph stays acyclic — ESM resolves it because instanceof is
// evaluated at call time, never at module-init.
import { AString } from "./primitives/AString.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { ABool } from "./primitives/ABool.js";
import { APair } from "./primitives/APair.js";
import { ANil } from "./primitives/ANil.js";
import { ACharacter } from "./primitives/ACharacter.js";
import { ALambda, ANativeProcedure, ARosettaProcedure, DoorProcedure, type ACallable } from "./primitives/ACallable.js";
import { CLASS } from "../well-known-symbols.js";
import { tf } from "./tagless-final.js";
// Type-only — narrows the brand result to the evaluator's macro/syntax types so
// `is_macro_value` stays signature-compatible with eval/guards' `is_macro`. An
// `import type` erases at compile, so it adds NO value→eval runtime edge (it is
// not importing the class, only the type name).
import type { Macro } from "../eval/Macro.js";
import type { Syntax } from "../eval/Syntax.js";

export function is_plain_object(object: unknown): object is Record<string, unknown> {
  return object !== null && typeof object === "object" && object.constructor === Object;
}

/**
 * `nil` is the module-load singleton with empty provenance. Once `Nil` extends
 * AValue, `nil.withProvenance(p)` mints a FRESH Nil so the singleton's empty
 * provenance set is preserved (see ANil.ts — withProvenance mints a fresh
 * `ANil`). `restrictControlFlowProvenance` (evaluator.ts) does
 * exactly this when a control-flow arm resolves to nil while the predicate
 * carries non-empty provenance, so `=== nil` would silently report false on
 * those clones and cascade through `length` / `null?` / `car` / `cdr`
 * typechecks. Match by class instead — every Nil clone IS a Nil regardless of
 * which provenance set it's carrying. Spec §5.3 + the doc comment over
 * `restrictControlFlowProvenance` explain the mechanism.
 */
export function is_nil(value: unknown): value is ANil {
  return value instanceof ANil;
}

export function is_pair(o: unknown): o is APair<any, any> {
  return o instanceof APair;
}

/**
 * Scheme falsiness — the ONLY scheme-falsy value is `#f` (R7RS §6.3): a raw JS
 * `false`, a JS `null` (the membrane's #f sibling), or a boxed `ABool(false)`
 * (#f post-L1). Everything else — nil, 0, "", the empty list — is TRUTHY. This
 * is NOT JS falsiness; reading a scheme value with `!x` would wrongly treat 0/""
 * as false. Lives here (value-kernel leaf) rather than guards.ts so the value
 * primitives (APair/AVector filter, op-helpers' sort comparator) read truthiness
 * without dragging the evaluator world in; guards.ts re-exports it for the
 * evaluator/env call sites. Replaces op-helpers' former private `isSchemeFalse`
 * twin, now collapsed into this single predicate.
 */
export function is_false(o: unknown): o is false | null | ABool {
  return o === false || o === null || (o instanceof ABool && o.value === false);
}

export const is_native = (obj: unknown): obj is AString | ACharacter | AExact | AInexact =>
  obj instanceof AString || obj instanceof ACharacter || obj instanceof AExact || obj instanceof AInexact;

/**
 * `is_macro` WITHOUT an import edge into the evaluator. A Macro / Syntax /
 * Syntax.Parameter each carry a stable `static [CLASS]` brand ("macro" /
 * "syntax" / "syntax-parameter" — eval/Macro.ts, eval/Syntax.ts),
 * read here off `constructor[CLASS]` exactly as utils/typecheck.ts does.
 * The brand is the value layer's downward-readable identity for the macro
 * classes, so the lineage shadow-cone skip can test "is this a macro?" with no
 * value→eval runtime edge — replacing the former `installMacroGuard` late-bound
 * DI (the last static-graph side effect, dissolved alongside the Pair sibling).
 *
 * This is a duck/brand test, not `instanceof`: a forged `{ constructor: { [CLASS]:
 * "macro" } }` would pass. That is acceptable for the shadow-cone skip — the
 * input is a value resolved from the run env (`env.get(op)`), never attacker
 * data, and the only consequence of a false positive is recording a top-level
 * form as macro-headed (out-of-scope-for-shadow), never a soundness break in the
 * emitted program. The brand set mirrors eval/guards' `is_macro` arms 1:1.
 */
const MACRO_CLASS_BRANDS: ReadonlySet<string> = new Set(["macro", "syntax", "syntax-parameter"]);
export function is_macro_value(o: unknown): o is Macro | Syntax {
  if (o === null || (typeof o !== "object" && typeof o !== "function")) return false;
  const ctor = (o as { constructor?: { [CLASS]?: unknown } }).constructor;
  const brand = ctor?.[CLASS];
  return typeof brand === "string" && MACRO_CLASS_BRANDS.has(brand);
}

// Pure structural predicates (no value-kernel deps at all). They live here
// rather than in guards.ts so leaf utilities (e.g. utils/typecheck.ts) can
// import them without reaching guards.ts and, through it, Environment/Macro.
export function is_function(o: unknown): o is Function {
  return typeof o === "function" && "bind" in o && typeof o.bind === "function";
}

// Callable-as-value guards (stage 0 of the callable-as-value rework; see
// docs/working-proposals/callable-as-value-run-ctx.md). `instanceof` is evaluated at call
// time, so importing these value classes into this leaf adds no init-time cycle. The legacy
// bare-fn `is_callable`/`is_macro` (eval/guards.js) coexist until the migration retires them.
export function is_lambda(o: unknown): o is ALambda {
  return o instanceof ALambda;
}
export function is_native_procedure(o: unknown): o is ANativeProcedure {
  return o instanceof ANativeProcedure;
}
export function is_rosetta_procedure(o: unknown): o is ARosettaProcedure {
  return o instanceof ARosettaProcedure;
}
/** A host-JS primitive callable — native (contour) OR rosetta (membrane). */
export function is_procedure(o: unknown): o is ANativeProcedure | ARosettaProcedure {
  return o instanceof ANativeProcedure || o instanceof ARosettaProcedure;
}
/** A bound DOOR (errors-as-doors — `symbol.notImplemented`) — resolves like any other
 *  binding, throws its teaching `PurityError` only on application. See `DoorProcedure`'s
 *  own doc (ACallable.ts) for why it's a real callable value, not a bare closure. */
export function is_door_procedure(o: unknown): o is DoorProcedure {
  return o instanceof DoorProcedure;
}
/** Any callable value — a lambda, a host-JS primitive, or a door. */
export function is_callable_value(o: unknown): o is ACallable {
  return (
    o instanceof ALambda ||
    o instanceof ANativeProcedure ||
    o instanceof ARosettaProcedure ||
    o instanceof DoorProcedure
  );
}

/** Structural, not nominal — unlike `is_callable_value`'s closed `ACallable` union, this
 *  admits ANY value answering `arrival/tagless-final/apply` (e.g. a self-applying keyword
 *  `ASymbol`). Used only at the evaluator's call-dispatch gates that must recognize such a
 *  value as invocable; `is_callable_value`'s other consumers (which rely on the narrowed
 *  `ACallable` type carrying `.arity`) are intentionally left alone. */
export function is_applyable(o: unknown): boolean {
  return typeof (o as Record<PropertyKey, unknown> | null | undefined)?.[tf("apply")] === "function";
}

export const has_own_symbol = (obj: unknown, symbol: symbol): boolean =>
  obj !== null && typeof obj === "object" ? Object.hasOwn(obj, symbol) : false;

export function is_iterator(obj: unknown, symbol: symbol): boolean {
  if (obj === null || typeof obj !== "object") return false;
  if (has_own_symbol(obj, symbol) || has_own_symbol(Object.getPrototypeOf(obj), symbol)) {
    return is_function((obj as Record<symbol, unknown>)[symbol]);
  }
  return false;
}

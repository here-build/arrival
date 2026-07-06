/**
 * Core Scheme value-type contracts extracted from lips.ts.
 * Concrete value classes live in ./primitives/*; this file keeps the pure
 * type/interface/guard surface they share.
 */

// SchemeValue is the honest union of every value the interpreter can hold:
// every concrete AValue subclass, the live non-AValue orphans (EOF, Values),
// and a JS function used as a Scheme procedure. Excludes QuotedPromise
// (dissolved) and DatumReference (reader-internal).
import type { AExact } from "./primitives/AExact.js";
import type { AInexact } from "./primitives/AInexact.js";
import type { APair } from "./primitives/APair.js";
import type { ANil } from "./primitives/ANil.js";
import type { AString } from "./primitives/AString.js";
import type { ASymbol } from "./primitives/ASymbol.js";
import type { ABool } from "./primitives/ABool.js";
import type { AVector } from "./primitives/AVector.js";
import type { ABytevector } from "./primitives/ABytevector.js";
import type { ACharacter } from "./primitives/ACharacter.js";
import type { AVoid } from "./primitives/AVoid.js";
import type { AHalfBaked } from "./primitives/AHalfBaked.js";
import type { AJSArray } from "./primitives/AJSArray.js";
import type { AJSObject } from "./primitives/AJSObject.js";
import type { EOF } from "./primitives/EOF.js";
import type { Values } from "./primitives/Values.js";
import type { Keyword } from "./Keyword.js";
// A caught condition that reaches a `(catch (e) …)` binding is an R7RS error
// object — `error-object?` is exactly `obj instanceof R7RSError` (bridge.ts).
// `import type` keeps this erased at runtime, so the type-only edge back to
// errors.ts (which already `import type { SchemeValue }`s from here) is a pure
// compile-time cycle TS resolves with no runtime circular dependency.
import type { R7RSError } from "../errors.js";
// A `AProcedure` is a JS function used as a Scheme procedure carrying optional
// LIPS metadata — the metadata-bearing form of the bare callable arm below, and
// a first-class *value* (unlike Macro/Syntax/Environment, which are env bindings
// but never values). It has no runtime brand distinguishing it from a plain
// procedure, so a value resolved from the env arrives typed as one and must be
// admitted here. `import type` keeps the edge to Environment.ts (which itself
// `import type { SchemeValue }`s from here) a pure compile-time cycle.
import { ImplInvocationCtx } from "../common/symbols/_bake.js";
import type { ACallable } from "./primitives/ACallable.js";

/**
 * Opaque marker for the trampoline's bounce sentinel. The real `Bounce`
 * (`{ __bounce: true; generator }`, declared in eval/evaluator.ts) can't be
 * imported here without a value cycle, and the value channel never needs its
 * `generator` field — only its brand. A `LambdaFunction`'s call may return one,
 * so the lambda-as-value arm of the union admits it; the call boundary narrows
 * it out (`is_bounce`) before any value use, so it never reaches a value slot.
 */
export interface SchemeBounceMarker {
  readonly __bounce: true;
}

export type SchemeValue =
  | AExact
  | AInexact
  | APair
  | ANil
  | AString
  | ASymbol
  | ABool
  | AVector
  | ABytevector
  | ACharacter
  | AVoid
  | AHalfBaked
  | AJSArray
  | AJSObject
  | Keyword
  | EOF
  | Values
  // A caught R7RS condition object, bound as the catch variable.
  | R7RSError
  // A JS function used as a Scheme procedure, with optional LIPS metadata.
  | AProcedure
  // A callable-as-value (stage 0 of the callable-as-value rework): ALambda /
  // ANativeProcedure / ARosettaProcedure. Additive alongside the legacy `AProcedure` fn arm
  // until the migration replaces it. `import type` keeps the edge to primitives/ACallable.ts
  // (which type-imports SchemeValue from here) a pure compile-time cycle.
  | ACallable;

// A Scheme lambda value: its body may return a value synchronously, a bounce
// token (under the trampoline's bounce protocol), or a Promise (JS-host entry
// path). The trampolined/async return is the honest truth of a lambda's call;
// the non-value returns are narrowed out at the call boundary before any use.
export type AProcedure<Args extends [...SchemeValue[]] = [...any[]], Result extends SchemeValue = any> = ((
  this: ImplInvocationCtx,
  ...args: Args
) => Result | SchemeBounceMarker | Promise<Result>) & {
  __name__?: string | symbol;
  __code__?: unknown;
};

// -------------------------------------------------------------------------
// :: SchemeStringLike interface - duck-typing for SchemeString class
// :: Placed first because other types reference it
// -------------------------------------------------------------------------
export interface SchemeStringLike {
  __string__: string | string[];
  valueOf(): string;
  toString(): string;
}

// SchemeString type guard - works with both interface and actual class
export function isSchemeString(x: unknown): x is SchemeStringLike {
  return typeof x === "object" && x !== null && "__string__" in x;
}

// Combined string check
export function isString(x: unknown): x is SchemeStringLike | string {
  return typeof x === "string" || isSchemeString(x);
}

// Forward declaration for Pair (implemented in lips.ts)
// This allows Nil.append to return the right type without circular dependency
export interface APairLike<Car extends SchemeValue = SchemeValue, Cdr extends SchemeValue = SchemeValue> {
  car: Car;
  cdr: Cdr;
}

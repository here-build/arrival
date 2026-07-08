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
import type { AJSArray } from "./primitives/AJSArray.js";
import type { AJSObject } from "./primitives/AJSObject.js";
import type { ADict } from "./primitives/ADict.js";
import type { EOF } from "./primitives/EOF.js";
import type { Values } from "./primitives/Values.js";
import type { Keyword } from "./Keyword.js";
// A caught condition reaching `(catch (e) …)` is an R7RS error object —
// `error-object?` is exactly `obj instanceof R7RSError` (bridge.ts). `import type`
// keeps this erased at runtime, so the mutual edge with errors.ts (which
// `import type`s SchemeValue from here) is a pure compile-time cycle.
import type { R7RSError } from "../errors.js";
// `AProcedure` is a JS function used as a Scheme procedure with optional LIPS
// metadata — a first-class *value* (unlike Macro/Syntax/Environment, which are
// env bindings, never values). No runtime brand distinguishes it from a plain
// procedure, so a value resolved from the env arrives typed as one. `import
// type` keeps the mutual edge with Environment.ts a pure compile-time cycle.
import type { CallCtx } from "./primitives/CallCtx.js";
import type { ACallable } from "./primitives/ACallable.js";
import { AValue } from "./primitives/AValue.js";

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

// `[T] extends [...]` (tuple-wrapped) on purpose: a naked `T extends ...` conditional
// DISTRIBUTES over the ~23-member SchemeValue union when `AListAlike` is used
// unparameterized, exploding into a union of concrete APair<X, …> shapes that
// unifies with no open generic (and trips TS2589 in deep spines).
//
// The maximal-T short-circuit (`[SchemeValue] extends [T]` arm) is load-bearing:
// when T is the whole union, the recursive cdr constraint adds no information —
// every element is already admissible — but it DOES make the alias strictly
// narrower than a plain `APair<SchemeValue, SchemeValue>` (whose cdr is not
// provably the recursive shape), so every real pair in the interpreter would
// fail to assign into the type that's supposed to describe it. Collapse the
// default to the honest `APair<SchemeValue, SchemeValue> | ANil` spine and keep
// the recursive precision only for genuinely narrowed element types.
type AArrayListAlike<T extends SchemeValue> = [SchemeValue] extends [T]
  ? APair<SchemeValue, SchemeValue> | ANil
  : APair<T, [T] extends [APair<any, any> | ANil] ? T : AArrayListAlike<T>> | ANil;
type ATupleListAlike<T extends [...SchemeValue[]]> = T extends [
  infer Car extends SchemeValue,
  ...infer Cdr extends SchemeValue[],
]
  ? APair<Car, ATupleListAlike<Cdr>>
  : ANil;

export type AListAlike<T extends SchemeValue | [...SchemeValue[]] = SchemeValue> = [T] extends [[...SchemeValue[]]]
  ? ATupleListAlike<T>
  : [T] extends [SchemeValue]
    ? AArrayListAlike<T>
    : never;

export type AListAlikeValue<T extends AListAlike> = T extends AListAlike<infer V> ? V : never;
export type APairAsListValue<Car extends SchemeValue, Cdr extends SchemeValue> =
  | Car
  | (Cdr extends AListAlike ? AListAlikeValue<Cdr> : never);

export type SchemeValue =
  | AExact
  | AInexact
  | APair<any, any>
  | ANil
  | AString
  | ASymbol
  | ABool
  | AVector
  | ABytevector
  | ACharacter
  | AVoid
  | AJSArray
  | AJSObject
  | ADict
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
  this: CallCtx,
  ...args: Args
) => Result | SchemeBounceMarker | Promise<Result>) & {
  __name__?: string | symbol;
  __code__?: unknown;
};

// Duck-typing interface for SchemeString, placed first because other types reference it.
export interface SchemeStringLike {
  __string__: string | string[];
  valueOf(): string;
  toString(): string;
}

export function isSchemeString(x: unknown): x is SchemeStringLike {
  return typeof x === "object" && x !== null && "__string__" in x;
}

export function isString(x: unknown): x is SchemeStringLike | string {
  return typeof x === "string" || isSchemeString(x);
}

// AList: the "APair | ANil" scheme-list spine spelled out ~50x across the codebase.
// Deliberately NOT recursive (type AList<T> = APair<T, AList<T>|ANil>) -- APair's own
// method shapes are already self-referential through Cdr (see AConcatPair/APairValue),
// and a prior "type instantiation excessively deep" error on APair itself was fixed by
// falling back to APair<any,any>. A second layer of alias recursion risks the same wall.
// Car/Cdr default to `any`, matching the inline union verbatim -- no call site in this
// codebase threads a real element type through the Cdr slot today. The `extends SchemeValue`
// bound (mirroring APairLike above and APair's own class signature) is load-bearing, not
// decoration -- APair<Car, Cdr>'s own params require it, so a bare unconstrained `Car = any`
// fails to satisfy APair's constraint at the alias's own declaration site.
export type AList<Car extends SchemeValue = any, Cdr extends Car extends ANil ? ANil : SchemeValue = any> =
  | APair<Car, Cdr>
  | ANil;

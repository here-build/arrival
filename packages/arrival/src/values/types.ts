/**
 * Core Scheme value-type contracts extracted from lips.ts.
 * Concrete value classes live in ./primitives/*; this file keeps the pure
 * type/interface/guard surface they share.
 */

// SchemeValue is the generic type for any Scheme value
// Scheme is inherently dynamic - uses `any` for interpreter interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SchemeValue = any;

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
export interface PairLike<Car = unknown, Cdr = unknown> {
  car: Car;
  cdr: Cdr;
}

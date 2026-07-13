// Dual type-guard harvest signatures for R7RS `?` predicates.
//
// Prelude emits `declare const name: SIG`. A monomorphic
//   (x: unknown) => x is List<unknown>
// already intersects with the input type (so `string | List<number>` often
// keeps `List<number>`), but fails to *preserve* when we need an explicit
// Extract path, and dual call-signatures are the idiomatic TS form:
//
//   { (x: unknown): x is List<unknown>;
//     <T>(x: T): x is Extract<T, List<any>>; }
//
// Rule: the predicate result must be assignable to the parameter type — so we
// only *narrow* via Extract, never rewrite T into an unrelated List<…>.

/**
 * Dual call-signature type-guard for harvest `type:`.
 *
 * @param unknownIs  — narrow of pure `unknown` (e.g. `List<unknown>`)
 * @param extractAs  — Extract target; use a free `any` element (`List<any>`) so
 *                     element type parameters on list/pair/vector branches survive.
 *                     Defaults to `unknownIs` (scalars: string, boolean, …).
 */
export function dualTypeGuard(unknownIs: string, extractAs: string = unknownIs): string {
  return `{ (x: unknown): x is ${unknownIs}; <T>(x: T): x is Extract<T, ${extractAs}>; }`;
}

/** Container dual-guards (free element params on the Extract arm). */
export const LIST_TYPE_GUARD = dualTypeGuard("List<unknown>", "List<any>");
export const PAIR_TYPE_GUARD = dualTypeGuard("Pair<unknown, unknown>", "Pair<any, any>");
export const VECTOR_TYPE_GUARD = dualTypeGuard("readonly unknown[]", "readonly any[]");

/** Scalar dual-guards. */
export const STRING_TYPE_GUARD = dualTypeGuard("string");
export const BOOLEAN_TYPE_GUARD = dualTypeGuard("boolean");
export const NULL_TYPE_GUARD = dualTypeGuard("null");
export const NUMBER_TYPE_GUARD = dualTypeGuard("number | bigint");
export const EXACT_TYPE_GUARD = dualTypeGuard("bigint");
export const INEXACT_TYPE_GUARD = dualTypeGuard("number");
export const BYTEVECTOR_TYPE_GUARD = dualTypeGuard("Uint8Array");
export const DICT_TYPE_GUARD = dualTypeGuard("Record<string, unknown>");
export const PROCEDURE_TYPE_GUARD = dualTypeGuard("(...args: unknown[]) => unknown");

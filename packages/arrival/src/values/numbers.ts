/**
 * Scheme numeric tower (R7RS-small §6.2: integer ⊂ rational ⊂ real, exact/inexact).
 * - AExact: safe-integer RATIO (`number` num/denom, both always `Number.isSafeInteger`)
 *   — integers AND rationals (denom=1 is the integer case). Out-of-range results THROW
 *   (crash-on-overflow), never silently coerce — see `values/mint-numeric.ts`.
 * - AInexact: IEEE 754 binary64 real, boxed.
 * Tower predicates check VALUES, not types.
 *
 * COMPLEX SUBSETTING (R7RS §6.2.3 permits omitting complex): reals-only, no imaginary
 * axis. sqrt of a negative, make-rectangular/make-polar, "3+4i" literals, and
 * real-part/imag-part/magnitude/angle are DOORED via complexDoor. complex? is an
 * honest stub — always #f; no complex value exists to answer #t.
 */
import invariant from "tiny-invariant";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { ComplexNumberError } from "../errors.js";

/**
 * Complex tower omitted (R7RS §6.2.3). Door recognizes the omitted feature and
 * explains the real-only alternative. See `ComplexNumberError` (errors.ts).
 */
export function complexDoor(): never {
  throw new ComplexNumberError();
}

export type ANumeric = AExact | AInexact;

/**
 * Integer square root of a non-negative safe-integer `number` (`exact-integer-sqrt`).
 * Under the safe-int invariant `n` never exceeds `Number.MAX_SAFE_INTEGER`, so a float
 * estimate plus correction suffices. `Math.sqrt` can be off by one at the boundary;
 * the two correction loops walk to the true integer sqrt. Returns r with
 * r*r ≤ n < (r+1)*(r+1).
 */
export function exactISqrt(n: number): number {
  invariant(Number.isSafeInteger(n) && n >= 0, "isqrt: requires a non-negative safe integer");
  if (n < 2) return n;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

/**
 * Real value from SchemeNumeric. Lives in the value layer so number classes' own
 * `arrival/tagless-final/lte` can compute without an operators→numbers cycle.
 */
export function toReal(n: ANumeric): number {
  if (n instanceof AExact) {
    return n.num / n.denom;
  }
  return n.real;
}

/**
 * Three-way comparison: -1 / 0 / 1, or NaN if incomparable (either operand NaN).
 * Exact/exact routes through `AExact.cmp` (safe-int cross-multiply, float fallback
 * on overflow). Inexact falls back to `toReal` where float comparison is correct.
 */
export function schemeCompare(a: ANumeric, b: ANumeric): number {
  if (a instanceof AExact && b instanceof AExact) {
    return a.cmp(b);
  }
  const ar = toReal(a);
  const br = toReal(b);
  if (ar < br) return -1;
  if (ar > br) return 1;
  if (ar === br) return 0;
  return Number.NaN;
}

/** Honest stub — complex tower omitted (R7RS §6.2.3). Always #f. */
export function isComplex(_n: unknown): boolean {
  return false;
}

export function isInteger(n: unknown): n is AExact | number {
  if (n instanceof AExact) {
    return n.denom === 1;
  }
  if (n instanceof AInexact) {
    return false;
  }
  // Host bigint is not a scheme number (membrane NoLensError).
  if (typeof n === "number") {
    return Number.isInteger(n);
  }
  return false;
}

// INTEROP BOUNDARY: AExact/AInexact carry the tower surface on their prototypes.
// The nominal FAMILY RULE in interop-access.ts (`instanceof AValue`) restricts
// interop member-access to own properties (num/denom / real) — blocking tower methods.
// Arithmetic ops scheme uses (`+`, `*`, `floor`, …) live in env bindings, not on these prototypes.

/**
 * Scheme Numeric Tower Implementation (R7RS-small §6.2: integer ⊂ rational ⊂ real,
 * exact/inexact). Two classes based on exactness, both always present:
 * - AExact: arbitrary precision (bigint num/denom) — represents integers AND
 *   rationals (denom=1 is the integer case).
 * - AInexact: IEEE 754 binary64 real, boxed.
 * Tower predicates check VALUES, not types.
 *
 * COMPLEX SUBSETTING (R7RS § 6.2.3 permits omitting complex): arrival is reals-only,
 * no imaginary axis. sqrt of a negative, make-rectangular/make-polar, a "3+4i"
 * literal, and real-part/imag-part/magnitude/angle are all DOORED (recognized,
 * rejected with a teaching message via complexDoor) rather than silently
 * misparsed. complex? still answers #t for every real (real ⊂ complex by spec —
 * the predicate stays total; only the imaginary axis is gone).
 */
import { CLASS } from "../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./primitives/RunContext.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./primitives/AValue.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";

// ============================================================================
// Complex-subsetting door (errors-as-doors)
// ============================================================================

/**
 * The single teaching message for every complex-number rejection. arrival omits
 * the complex tower entirely (R7RS § 6.2.3 permits this); the door RECOGNIZES the
 * omitted feature and explains the real-only alternative, rather than silently
 * misparsing or returning a wrong value. Matches arrival's %purity-door discipline.
 */
export const COMPLEX_DOOR_MESSAGE =
  "complex numbers are not supported in arrival — inexact reals only; pass real/imag as separate values";

export function complexDoor(): never {
  throw new Error(COMPLEX_DOOR_MESSAGE);
}

// ============================================================================
// Type Definitions
// ============================================================================

export type ANumeric = AExact | AInexact;

/**
 * Integer square root of a non-negative bigint via Newton's method.
 * Math.sqrt(Number(n)) loses precision for n ≥ 2^53 and misclassifies large
 * perfect squares; bigint Newton is exact at every scale. Returns r with
 * r*r ≤ n < (r+1)*(r+1).
 */
export function bigintISqrt(n: bigint): bigint {
  invariant(n >= 0n, "isqrt: negative");
  if (n < 2n) return n;
  let r = 1n << ((BigInt(n.toString(2).length) + 1n) / 2n);
  while (true) {
    const next = (r + n / r) / 2n;
    if (next >= r) break;
    r = next;
  }
  while (r * r > n) r -= 1n;
  return r;
}
// ============================================================================
// Numeric comparison — the value-layer cmp the operators + numbers' Ord share
// ============================================================================

/**
 * Get real value from SchemeNumeric. (Reals-only — every inexact is real.)
 *
 * Lives in the value layer (not operators/numeric.ts) so the number classes' own
 * `arrival/tagless-final/lte` Ord can compute by-value without the operators→numbers cycle.
 */
export function toReal(n: ANumeric): number {
  if (n instanceof AExact) {
    return Number(n.num) / Number(n.denom);
  }
  return n.real;
}

/**
 * Three-way comparison of two reals: -1 / 0 / 1, or NaN if incomparable
 * (either operand is a NaN inexact). The exact/exact case routes through
 * `SchemeExact.cmp` (bigint cross-multiplication) instead of coercing to a
 * JS double — that float coercion was the source of the R7RS bug where
 * `(< 999999999999999998 999999999999999999)` returned #f: both 18-digit
 * integers collapse to the same double (1e18), so `prev < curr` was false.
 * Only when at least one side is inexact do we fall back to `toReal`, where
 * the precision is already gone and float comparison is the correct semantics
 * (and NaN naturally propagates → every comparison against it is #f).
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
  return Number.NaN; // a NaN operand → incomparable; all chained tests fail
}

export function parseNumber(str: string): ANumeric {
  str = str.trim();

  // Handle exactness prefixes
  let forceExact = false;
  let forceInexact = false;

  if (str.startsWith("#e") || str.startsWith("#E")) {
    forceExact = true;
    str = str.slice(2);
  } else if (str.startsWith("#i") || str.startsWith("#I")) {
    forceInexact = true;
    str = str.slice(2);
  }

  // Handle radix prefixes
  let radix = 10;
  if (str.startsWith("#b") || str.startsWith("#B")) {
    radix = 2;
    str = str.slice(2);
  } else if (str.startsWith("#o") || str.startsWith("#O")) {
    radix = 8;
    str = str.slice(2);
  } else if (str.startsWith("#d") || str.startsWith("#D")) {
    radix = 10;
    str = str.slice(2);
  } else if (str.startsWith("#x") || str.startsWith("#X")) {
    radix = 16;
    str = str.slice(2);
  }

  // Handle special values
  if (str === "+inf.0") return new AInexact(CONSTANT_CTX, Infinity);
  if (str === "-inf.0") return new AInexact(CONSTANT_CTX, -Infinity);
  if (str === "+nan.0" || str === "-nan.0") return new AInexact(CONSTANT_CTX, Number.NaN);

  // Complex literals (a+bi / a-bi) are DOORED — recognize the shape, reject with
  // the teaching message (complex not supported), never silently misparse.
  const complexMatch = str.match(/^([+-]?[\d.]+)?([+-][\d.]*)?i$/);
  if (complexMatch) {
    const imag = complexMatch[2] === undefined ? 1 : Number.parseFloat(complexMatch[2] || "+1");
    // A genuinely-zero imaginary part is just the real number; only a nonzero
    // imaginary axis is unrepresentable.
    if (imag === 0) {
      const real = complexMatch[1] ? Number.parseFloat(complexMatch[1]) : 0;
      return new AInexact(CONSTANT_CTX, real);
    }
    return complexDoor();
  }

  // Handle rational (a/b)
  const rationalMatch = str.match(/^([+-]?\d+)\/(\d+)$/);
  if (rationalMatch) {
    const num = BigInt(rationalMatch[1]);
    const denom = BigInt(rationalMatch[2]);
    const result = new AExact(CONSTANT_CTX, num, denom);
    if (forceInexact && result instanceof AExact) {
      return result.toInexact();
    }
    return result;
  }

  // Handle decimal
  if (str.includes(".") || str.includes("e") || str.includes("E")) {
    const value = Number.parseFloat(str);
    if (forceExact) {
      return new AInexact(CONSTANT_CTX, value).toExact();
    }
    return new AInexact(CONSTANT_CTX, value);
  }

  // Handle integer. Parse the magnitude via BigInt so digits beyond 2^53 are
  // preserved — `parseInt` would round to a lossy double before we ever reach
  // `BigInt(...)`. BigInt accepts radix prefixes (0x/0o/0b) but not a trailing
  // sign on them, so split the sign off first.
  const neg = str.startsWith("-");
  const digits = neg || str.startsWith("+") ? str.slice(1) : str;
  const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : radix === 2 ? "0b" : "";
  const magnitude = BigInt(prefix + digits);
  const exact = new AExact(CONSTANT_CTX, neg ? -magnitude : magnitude);
  if (forceInexact) {
    return exact.toInexact();
  }
  return exact;
}

export function isSchemeNumeric(value: unknown): value is ANumeric {
  return value instanceof AExact || value instanceof AInexact;
}

/** Unlike `isSchemeNumeric`, also admits a raw (unboxed) JS number/bigint. */
export function isNumeric(value: unknown): value is ANumeric | number | bigint {
  return isSchemeNumeric(value) || typeof value === "number" || typeof value === "bigint";
}

// ============================================================================
// Type Checking Functions
// ============================================================================

/**
 * Check if value is complex (has a non-zero imaginary part). arrival is reals-only,
 * so no representable value is ever complex — always #f. (Kept as a total guard so
 * callers don't need to special-case its removal.)
 */
export function isComplex(_n: unknown): boolean {
  return false;
}

export function isInteger(n: unknown): n is AExact | bigint | number {
  if (n instanceof AExact) {
    return n.denom === 1n;
  }
  if (n instanceof AInexact) {
    return false;
  }
  if (typeof n === "bigint") {
    return true;
  }
  if (typeof n === "number") {
    return Number.isInteger(n);
  }
  return false;
}

// ============================================================================
// INTEROP BOUNDARIES
// ============================================================================
// AExact/AInexact carry the full numeric-tower behavior surface (isInteger/
// isRational/isReal getters + arithmetic protocol) on their prototypes. Numeric
// values are the densest object population in any inference computation, and
// symbol-to-field auto-resolution makes each number a potential probe point
// into the host numeric tower. Boundary-marking restricts interop member-access
// to own properties (num/denom for exact, real for inexact) — the intended
// data surface — blocking the tower-internals methods. The arithmetic ops
// scheme code actually uses (`+`, `*`, `floor`, …) live in env bindings, not
// on these prototypes.
// ============================================================================

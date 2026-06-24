/**
 * Scheme Numeric Tower Implementation
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. ExactNumber class always exists - minimum capability is integers (denom=1)
 * 2. InexactNumber class always exists - it is a boxed IEEE-754 real
 * 3. Classes are constants, behaviors are variables
 * 4. Tower predicates check values, not types: integer ⊂ rational ⊂ real
 *
 * Two fundamental classes based on exactness:
 * - ExactNumber: arbitrary precision (bigint num/denom), represents integers AND rationals
 * - InexactNumber: floating point (number real), represents reals
 *
 * COMPLEX SUBSETTING (R7RS § 6.2.3 explicitly permits omitting complex): arrival is
 * reals-only. The inexact tower carries NO imaginary axis. sqrt of a negative,
 * make-rectangular / make-polar, and a "3+4i" literal are DOORED (recognized and
 * rejected with a teaching message via complexDoor), never silently misparsed.
 * real-part / imag-part / magnitude / angle are likewise doored. complex? still
 * answers #t for every real (real ⊂ complex by spec — the predicate stays total;
 * only the imaginary axis is gone).
 *
 * Behaviors control what OPERATIONS produce, not what values can exist:
 * - IntegerExact: 1/3 → InexactNumber (demotes non-integer results)
 * - RationalExact: 1/3 → ExactNumber(1n,3n) (keeps exact fractions)
 * - RealInexact: sqrt(-4) → door (complex not supported)
 *
 * Lineage: R7RS-small §6.2 numeric tower (integer ⊂ rational ⊂ real, exact/inexact);
 * inexacts are IEEE 754 binary64; integer sqrt is Newton–Raphson.
 */
import { CLASS } from "../well-known-symbols.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "../interop-access.js";

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

export type SchemeNumeric = SchemeExact | SchemeInexact;

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
// ExactNumber - Arbitrary Precision (integers and rationals)
// ============================================================================

export class SchemeExact extends AValue {
  static [CLASS] = "number";
  readonly kind = "number" as const;

  readonly num: bigint;
  readonly denom: bigint;

  constructor(num: bigint, denom: bigint = 1n, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    // Normalize: keep denom positive, reduce to lowest terms
    invariant(denom != 0n, "Division by zero");
    if (denom < 0n) {
      num = -num;
      denom = -denom;
    }
    const g = SchemeExact.gcd(num < 0n ? -num : num, denom);
    this.num = num / g;
    this.denom = denom / g;
  }

  // Tower predicates - check mathematical properties
  get isInteger(): boolean {
    return this.denom === 1n;
  }

  get isRational(): boolean {
    return true; // all exact numbers are rational
  }

  get isReal(): boolean {
    return true; // all rationals are real
  }

  get isComplex(): boolean {
    return true; // all reals are complex (real ⊂ complex; predicate stays total)
  }

  // Exactness
  get isExact(): boolean {
    return true;
  }

  // Value checks
  get isZero(): boolean {
    return this.num === 0n;
  }

  get isPositive(): boolean {
    return this.num > 0n;
  }

  get isNegative(): boolean {
    return this.num < 0n;
  }

  get isNaN(): boolean {
    return false; // exact numbers are never NaN
  }

  get isFinite(): boolean {
    return true; // exact numbers are always finite
  }

  private static gcd(a: bigint, b: bigint): bigint {
    while (b !== 0n) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  // Conversion to JS
  valueOf(): number {
    return Number(this.num) / Number(this.denom);
  }

  toJS(): number | bigint {
    if (this.denom === 1n) {
      // Return bigint for integers if safe, otherwise number
      if (this.num >= BigInt(Number.MIN_SAFE_INTEGER) && this.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(this.num);
      }
      return this.num;
    }
    return this.valueOf();
  }

  /** AValue contract; aliases existing `toJS` (lowercase). */
  toJs(): number | bigint {
    return this.toJS();
  }

  withProvenance(p: ReadonlySet<number>): SchemeExact {
    return new SchemeExact(this.num, this.denom, p);
  }

  // String representation
  toString(): string {
    if (this.denom === 1n) {
      return this.num.toString();
    }
    return `${this.num}/${this.denom}`;
  }

  // Comparison (same-type)
  cmp(other: SchemeExact): -1 | 0 | 1 {
    const diff = this.num * other.denom - other.num * this.denom;
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }

  equals(other: SchemeExact): boolean {
    return this.num === other.num && this.denom === other.denom;
  }

  // Setoid (Fantasy Land). Exact ≡ exact ONLY — never equal to an inexact
  // (R7RS eqv?). structuralEqual / equal? consult this BEFORE their valueOf
  // fast-path, so this is what makes `(equal? 1 1.0)` correctly #f.
  // (algebras-in-entities migration — plan-2026-06-10-algebras-in-entities.md.)
  ["fantasy-land/equals"](other: unknown): boolean {
    return other instanceof SchemeExact && this.equals(other);
  }

  // Ord (Fantasy Land, extends Setoid). NUMERIC value comparison via schemeCompare
  // — `(<= 1 1.0)` is #t (cross-type via toReal), unlike the representation Setoid
  // above where exact ≠ inexact. NaN ⇒ schemeCompare returns NaN ⇒ `NaN <= 0` is #f,
  // so every relation derived from this collapses to #f on a NaN operand, exactly
  // like the numeric `<=` Operator. Non-number → false (Ord convention).
  ["fantasy-land/lte"](other: unknown): boolean {
    return (
      (other instanceof SchemeExact || other instanceof SchemeInexact) &&
      schemeCompare(this, other, "<=") <= 0
    );
  }

  // Same-type arithmetic
  add(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.denom + other.num * this.denom, this.denom * other.denom);
  }

  sub(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.denom - other.num * this.denom, this.denom * other.denom);
  }

  mul(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.num, this.denom * other.denom);
  }

  div(other: SchemeExact): SchemeExact {
    return new SchemeExact(this.num * other.denom, this.denom * other.num);
  }

  neg(): SchemeExact {
    return new SchemeExact(-this.num, this.denom);
  }

  abs(): SchemeExact {
    return new SchemeExact(this.num < 0n ? -this.num : this.num, this.denom);
  }

  inverse(): SchemeExact {
    return new SchemeExact(this.denom, this.num);
  }

  // Floor, ceiling, truncate, round - return exact integers
  floor(): SchemeExact {
    if (this.denom === 1n) return this;
    const q = this.num / this.denom;
    // Floor: round toward negative infinity
    if (this.num < 0n && this.num % this.denom !== 0n) {
      return new SchemeExact(q - 1n);
    }
    return new SchemeExact(q);
  }

  ceiling(): SchemeExact {
    if (this.denom === 1n) return this;
    const q = this.num / this.denom;
    // Ceiling: round toward positive infinity
    if (this.num > 0n && this.num % this.denom !== 0n) {
      return new SchemeExact(q + 1n);
    }
    return new SchemeExact(q);
  }

  truncate(): SchemeExact {
    if (this.denom === 1n) return this;
    // Truncate: round toward zero
    return new SchemeExact(this.num / this.denom);
  }

  round(): SchemeExact {
    if (this.denom === 1n) return this;
    // Round to nearest, ties to even
    const q = this.num / this.denom;
    const r = this.num % this.denom;
    const absR = r < 0n ? -r : r;
    const halfDenom = this.denom / 2n;

    if (absR < halfDenom) {
      return new SchemeExact(q);
    } else if (absR > halfDenom) {
      return new SchemeExact(this.num < 0n ? q - 1n : q + 1n);
    } else {
      // Tie: round to even
      if (q % 2n === 0n) {
        return new SchemeExact(q);
      }
      return new SchemeExact(this.num < 0n ? q - 1n : q + 1n);
    }
  }

  // Integer operations (only valid when isInteger)
  mod(other: SchemeExact): SchemeExact {
    invariant(this.isInteger && other.isInteger, "mod requires integers");
    return new SchemeExact(this.num % other.num);
  }

  quotient(other: SchemeExact): SchemeExact {
    invariant(this.isInteger && other.isInteger, "quotient requires integers");
    return new SchemeExact(this.num / other.num);
  }

  gcd(other: SchemeExact): SchemeExact {
    invariant(this.isInteger && other.isInteger, "gcd requires integers");
    return new SchemeExact(
      SchemeExact.gcd(this.num < 0n ? -this.num : this.num, other.num < 0n ? -other.num : other.num),
    );
  }

  // Convert to inexact
  toInexact(): SchemeInexact {
    return new SchemeInexact(this.valueOf());
  }
}

// ============================================================================
// InexactNumber - Floating Point (reals only; complex axis omitted, see header)
// ============================================================================

export class SchemeInexact extends AValue {
  static [CLASS] = "number";
  readonly kind = "number" as const;

  readonly real: number;

  constructor(real: number, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    this.real = real;
  }

  // Tower predicates - check mathematical properties
  get isInteger(): boolean {
    return Number.isInteger(this.real);
  }

  get isRational(): boolean {
    // R7RS: All finite real numbers are rational (representable as ratio of integers)
    // IEEE 754 floats are by definition dyadic fractions
    return Number.isFinite(this.real);
  }

  // Reals-only tower: every inexact value IS real (the imaginary axis is gone).
  // The old `-2.5+0.0i` deviation dissolves — there is no imaginary part to test.
  get isReal(): boolean {
    return true;
  }

  get isComplex(): boolean {
    return true; // all reals are complex (real ⊂ complex; predicate stays total)
  }

  // Exactness
  get isExact(): boolean {
    return false;
  }

  // Value checks
  get isZero(): boolean {
    return this.real === 0;
  }

  get isPositive(): boolean {
    return this.real > 0;
  }

  get isNegative(): boolean {
    return this.real < 0;
  }

  get isNaN(): boolean {
    return Number.isNaN(this.real);
  }

  get isFinite(): boolean {
    return Number.isFinite(this.real);
  }

  private static floatToRational(x: number, tolerance: number = 1e-10): SchemeExact {
    if (Number.isInteger(x)) {
      return new SchemeExact(BigInt(x));
    }

    // Simple approach: use decimal representation
    const str = x.toString();
    const dotIndex = str.indexOf(".");
    if (dotIndex === -1) {
      return new SchemeExact(BigInt(x));
    }

    const decimals = str.length - dotIndex - 1;
    const denom = 10n ** BigInt(decimals);
    const num = BigInt(str.replace(".", ""));
    return new SchemeExact(num, denom);
  }

  // Conversion to JS
  valueOf(): number {
    return this.real;
  }

  toJS(): number {
    return this.real;
  }

  /** AValue contract; mirrors the `schemeToJs` rosetta path (reals-only). */
  toJs(): number {
    return this.real;
  }

  withProvenance(p: ReadonlySet<number>): SchemeInexact {
    return new SchemeInexact(this.real, p);
  }

  // String representation. Reals-only — emit the Scheme inexact form with a
  // decimal point, and the chibi-compatible markers for the non-finite values.
  toString(): string {
    if (Number.isInteger(this.real)) {
      return `${this.real}.0`;
    }
    if (Number.isNaN(this.real)) return "+nan.0";
    if (this.real === Infinity) return "+inf.0";
    if (this.real === -Infinity) return "-inf.0";
    return this.real.toString();
  }

  // Comparison. Returns NaN when either operand is a NaN inexact: R7RS § 6.2.6 —
  // every numeric comparison against +nan.0 is #f, so callers using
  // `cmp(b) === 0` / `< 0` / `> 0` all correctly yield #f (NaN compares false
  // against every relation), instead of the old `return 0` which made
  // `(= +nan.0 x)` spuriously #t.
  cmp(other: SchemeInexact): -1 | 0 | 1 | number {
    if (this.real < other.real) return -1;
    if (this.real > other.real) return 1;
    if (this.real === other.real) return 0;
    return Number.NaN; // a NaN operand → incomparable
  }

  equals(other: SchemeInexact): boolean {
    return this.real === other.real;
  }

  // Setoid (Fantasy Land). Inexact ≡ inexact ONLY. Object.is (not ===) so
  // reflexivity holds for NaN (`(eqv? +nan.0 +nan.0)` ⇒ #t) and ±0 stay
  // distinct — matching the legacy `equal` number-branch semantics.
  ["fantasy-land/equals"](other: unknown): boolean {
    return other instanceof SchemeInexact && Object.is(this.real, other.real);
  }

  // Ord (Fantasy Land, extends Setoid). NUMERIC value comparison via schemeCompare
  // — same numeric/NaN semantics as SchemeExact's lte (cross-type, NaN ⇒ #f). The
  // representation Setoid above uses Object.is (so eqv? NaN is reflexive); this Ord
  // uses schemeCompare (so `(= +nan.0 +nan.0)` is #f) — two genuine comparisons.
  // Non-number → false (Ord convention).
  ["fantasy-land/lte"](other: unknown): boolean {
    return (
      (other instanceof SchemeExact || other instanceof SchemeInexact) &&
      schemeCompare(this, other, "<=") <= 0
    );
  }

  // Same-type arithmetic (reals-only)
  add(other: SchemeInexact): SchemeInexact {
    return new SchemeInexact(this.real + other.real);
  }

  sub(other: SchemeInexact): SchemeInexact {
    return new SchemeInexact(this.real - other.real);
  }

  mul(other: SchemeInexact): SchemeInexact {
    return new SchemeInexact(this.real * other.real);
  }

  div(other: SchemeInexact): SchemeInexact {
    // IEEE division directly: 1.0/0.0 = +inf.0, -1.0/0.0 = -inf.0, 0.0/0.0 = +nan.0.
    return new SchemeInexact(this.real / other.real);
  }

  neg(): SchemeInexact {
    return new SchemeInexact(-this.real);
  }

  abs(): SchemeInexact {
    return new SchemeInexact(Math.abs(this.real));
  }

  // Floor, ceiling, truncate, round
  floor(): SchemeInexact {
    return new SchemeInexact(Math.floor(this.real));
  }

  ceiling(): SchemeInexact {
    return new SchemeInexact(Math.ceil(this.real));
  }

  truncate(): SchemeInexact {
    return new SchemeInexact(Math.trunc(this.real));
  }

  round(): SchemeInexact {
    // Scheme rounds to even on ties
    const floored = Math.floor(this.real);
    const diff = this.real - floored;
    if (diff < 0.5) return new SchemeInexact(floored);
    if (diff > 0.5) return new SchemeInexact(floored + 1);
    // Tie: round to even
    if (floored % 2 === 0) return new SchemeInexact(floored);
    return new SchemeInexact(floored + 1);
  }

  // Transcendental functions (reals-only). sqrt of a negative DOORS — complex
  // results are not representable (see header / complexDoor).
  sqrt(): SchemeInexact {
    if (this.real < 0) complexDoor();
    return new SchemeInexact(Math.sqrt(this.real));
  }

  exp(): SchemeInexact {
    return new SchemeInexact(Math.exp(this.real));
  }

  log(): SchemeInexact {
    return new SchemeInexact(Math.log(this.real));
  }

  sin(): SchemeInexact {
    return new SchemeInexact(Math.sin(this.real));
  }

  cos(): SchemeInexact {
    return new SchemeInexact(Math.cos(this.real));
  }

  tan(): SchemeInexact {
    return new SchemeInexact(Math.tan(this.real));
  }

  pow(exponent: SchemeInexact): SchemeInexact {
    if (this.isZero) {
      // R7RS § 6.2.6: 0^0 = 1; 0^positive = 0; 0^negative is undefined
      // (division by zero).
      if (exponent.isZero) return new SchemeInexact(1);
      invariant(exponent.real > 0, "expt: 0 raised to a negative power (division by zero)");
      return new SchemeInexact(0);
    }
    return new SchemeInexact(Math.pow(this.real, exponent.real));
  }

  // Convert to exact (if possible)
  toExact(): SchemeExact {
    invariant(Number.isFinite(this.real), "Infinite number cannot be converted to exact");
    invariant(!Number.isNaN(this.real), "NaN cannot be converted to exact");
    // Convert float to rational
    return SchemeInexact.floatToRational(this.real);
  }
}

// ============================================================================
// Numeric comparison — the value-layer cmp the operators + numbers' Ord share
// ============================================================================

/**
 * Get real value from SchemeNumeric. (Reals-only — every inexact is real.)
 *
 * Lives in the value layer (not operators/numeric.ts) so the number classes' own
 * `fantasy-land/lte` Ord can compute by-value without the operators→numbers cycle.
 */
export function toReal(n: SchemeNumeric, _opName: string): number {
  if (n instanceof SchemeExact) {
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
export function schemeCompare(a: SchemeNumeric, b: SchemeNumeric, opName: string): number {
  if (a instanceof SchemeExact && b instanceof SchemeExact) {
    return a.cmp(b);
  }
  const ar = toReal(a, opName);
  const br = toReal(b, opName);
  if (ar < br) return -1;
  if (ar > br) return 1;
  if (ar === br) return 0;
  return Number.NaN; // a NaN operand → incomparable; all chained tests fail
}

// ============================================================================
// Behaviors - Configurable operation policies
// ============================================================================

export interface ExactBehavior {
  /** What to do when exact division doesn't produce an integer */
  div(a: SchemeExact, b: SchemeExact): SchemeNumeric;

  /** How to handle square root of exact number */
  sqrt(a: SchemeExact): SchemeNumeric;
}

export interface InexactBehavior {
  /** How to handle square root of negative real */
  sqrtNegative(a: SchemeInexact): SchemeNumeric;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rational-enabled exact behavior: keep fractions
// ─────────────────────────────────────────────────────────────────────────────
export const RationalExact: ExactBehavior = {
  div(a: SchemeExact, b: SchemeExact): SchemeNumeric {
    return a.div(b); // keeps as exact rational
  },

  sqrt(a: SchemeExact): SchemeNumeric {
    // sqrt of a negative is complex → doored (complex not supported).
    if (a.isNegative) {
      complexDoor();
    }
    if (a.isInteger) {
      const n = a.num;
      const root = bigintISqrt(n);
      if (root * root === n) {
        return new SchemeExact(root);
      }
    }
    // Not a perfect square, return inexact
    return a.toInexact().sqrt();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Integer-only exact behavior: demote fractions to inexact
// ─────────────────────────────────────────────────────────────────────────────
export const IntegerExact: ExactBehavior = {
  div(a: SchemeExact, b: SchemeExact): SchemeNumeric {
    const result = a.div(b);
    if (result.isInteger) {
      return result;
    }
    // Can't represent as exact integer, demote to inexact
    return result.toInexact();
  },

  sqrt(a: SchemeExact): SchemeNumeric {
    if (a.isNegative) {
      complexDoor();
    }
    if (a.isInteger) {
      const n = a.num;
      const root = bigintISqrt(n);
      if (root * root === n) {
        return new SchemeExact(root);
      }
    }
    return a.toInexact().sqrt();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Real-only inexact behavior: complex results are doored (the only behavior now)
// ─────────────────────────────────────────────────────────────────────────────
export const RealInexact: InexactBehavior = {
  sqrtNegative(_a: SchemeInexact): SchemeNumeric {
    return complexDoor();
  },
};

// ============================================================================
// Number Registry - Coordinates operations across types
// ============================================================================

export interface NumberConfig {
  exact: ExactBehavior;
  inexact: InexactBehavior;
}

export const SchemeConfig: NumberConfig = {
  exact: RationalExact,
  inexact: RealInexact,
};

export const RosettaConfig: NumberConfig = {
  exact: IntegerExact,
  inexact: RealInexact,
};

export class NumberRegistry {
  constructor(public config: NumberConfig) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Factory methods
  // ──────────────────────────────────────────────────────────────────────────

  fromInteger(n: bigint | number): SchemeExact {
    return new SchemeExact(BigInt(n));
  }

  fromRational(num: bigint | number, denom: bigint | number): SchemeNumeric {
    const exact = new SchemeExact(BigInt(num), BigInt(denom));
    // If rationals aren't supported, check if we need to demote
    if (this.config.exact === IntegerExact && !exact.isInteger) {
      return exact.toInexact();
    }
    return exact;
  }

  fromFloat(n: number): SchemeInexact {
    return new SchemeInexact(n);
  }

  /**
   * Constructing a number with an imaginary part is DOORED — arrival is reals-only
   * (complexDoor). A zero imaginary part is just the real number.
   */
  fromComplex(real: number, imag: number): SchemeNumeric {
    if (imag === 0) {
      return new SchemeInexact(real);
    }
    return complexDoor();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Coercion
  // ──────────────────────────────────────────────────────────────────────────

  /** Coerce to common type for binary operations */
  coerce(
    a: SchemeNumeric,
    b: SchemeNumeric,
  ): { kind: "exact"; a: SchemeExact; b: SchemeExact } | { kind: "inexact"; a: SchemeInexact; b: SchemeInexact } {
    if (a instanceof SchemeExact && b instanceof SchemeExact) {
      return { kind: "exact", a, b };
    }
    // One or both inexact: both become inexact
    const ia = a instanceof SchemeInexact ? a : a.toInexact();
    const ib = b instanceof SchemeInexact ? b : b.toInexact();
    return { kind: "inexact", a: ia, b: ib };
  }

  /** Convert inexact to exact */
  toExact(n: SchemeNumeric): SchemeExact {
    if (n instanceof SchemeExact) return n;
    return n.toExact();
  }

  /** Convert exact to inexact */
  toInexact(n: SchemeNumeric): SchemeInexact {
    if (n instanceof SchemeInexact) return n;
    return n.toInexact();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Binary operations with coercion
  // ──────────────────────────────────────────────────────────────────────────

  add(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.add(c.b) : c.a.add(c.b);
  }

  sub(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.sub(c.b) : c.a.sub(c.b);
  }

  mul(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.mul(c.b) : c.a.mul(c.b);
  }

  div(a: SchemeNumeric, b: SchemeNumeric): SchemeNumeric {
    const c = this.coerce(a, b);
    if (c.kind === "exact") {
      return this.config.exact.div(c.a, c.b);
    }
    return c.a.div(c.b);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Unary operations
  // ──────────────────────────────────────────────────────────────────────────

  neg(a: SchemeNumeric): SchemeNumeric {
    return a.neg();
  }

  abs(a: SchemeNumeric): SchemeNumeric {
    return a.abs();
  }

  sqrt(a: SchemeNumeric): SchemeNumeric {
    if (a instanceof SchemeExact) {
      return this.config.exact.sqrt(a);
    }
    if (a.real < 0) {
      return this.config.inexact.sqrtNegative(a);
    }
    return a.sqrt();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Comparison
  // ──────────────────────────────────────────────────────────────────────────

  // May return NaN when an operand is a NaN inexact (incomparable) — callers
  // here use `< 0` / `> 0` which correctly yield #f for NaN.
  compare(a: SchemeNumeric, b: SchemeNumeric): number {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.cmp(c.b) : c.a.cmp(c.b);
  }

  equals(a: SchemeNumeric, b: SchemeNumeric): boolean {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.equals(c.b) : c.a.equals(c.b);
  }

  lessThan(a: SchemeNumeric, b: SchemeNumeric): boolean {
    return this.compare(a, b) < 0;
  }

  greaterThan(a: SchemeNumeric, b: SchemeNumeric): boolean {
    return this.compare(a, b) > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tower predicates
  // ──────────────────────────────────────────────────────────────────────────

  isInteger(n: SchemeNumeric): boolean {
    return n.isInteger;
  }

  isRational(n: SchemeNumeric): boolean {
    return n.isRational;
  }

  isReal(n: SchemeNumeric): boolean {
    return n.isReal;
  }

  isComplex(n: SchemeNumeric): boolean {
    return n.isComplex;
  }

  isExact(n: SchemeNumeric): boolean {
    return n.isExact;
  }

  isZero(n: SchemeNumeric): boolean {
    return n.isZero;
  }

  isPositive(n: SchemeNumeric): boolean {
    return n.isPositive;
  }

  isNegative(n: SchemeNumeric): boolean {
    return n.isNegative;
  }

  isNaN(n: SchemeNumeric): boolean {
    return n.isNaN;
  }

  isFinite(n: SchemeNumeric): boolean {
    return n.isFinite;
  }
}

// ============================================================================
// Default registry (Scheme mode)
// ============================================================================

export const schemeNumbers = new NumberRegistry(SchemeConfig);
export const rosettaNumbers = new NumberRegistry(RosettaConfig);

/**
 * Parse a number from string representation
 */
export function parseNumber(str: string, registry: NumberRegistry = schemeNumbers): SchemeNumeric {
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
  if (str === "+inf.0") return new SchemeInexact(Infinity);
  if (str === "-inf.0") return new SchemeInexact(-Infinity);
  if (str === "+nan.0" || str === "-nan.0") return new SchemeInexact(Number.NaN);

  // Complex literals (a+bi / a-bi) are DOORED — recognize the shape, reject with
  // the teaching message (complex not supported), never silently misparse.
  const complexMatch = str.match(/^([+-]?[\d.]+)?([+-][\d.]*)?i$/);
  if (complexMatch) {
    const imag = complexMatch[2] === undefined ? 1 : Number.parseFloat(complexMatch[2] || "+1");
    // A genuinely-zero imaginary part is just the real number; only a nonzero
    // imaginary axis is unrepresentable.
    if (imag === 0) {
      const real = complexMatch[1] ? Number.parseFloat(complexMatch[1]) : 0;
      return new SchemeInexact(real);
    }
    return complexDoor();
  }

  // Handle rational (a/b)
  const rationalMatch = str.match(/^([+-]?\d+)\/(\d+)$/);
  if (rationalMatch) {
    const num = BigInt(rationalMatch[1]);
    const denom = BigInt(rationalMatch[2]);
    const result = registry.fromRational(num, denom);
    if (forceInexact && result instanceof SchemeExact) {
      return result.toInexact();
    }
    return result;
  }

  // Handle decimal
  if (str.includes(".") || str.includes("e") || str.includes("E")) {
    const value = Number.parseFloat(str);
    if (forceExact) {
      return new SchemeInexact(value).toExact();
    }
    return new SchemeInexact(value);
  }

  // Handle integer. Parse the magnitude via BigInt so digits beyond 2^53 are
  // preserved — `parseInt` would round to a lossy double before we ever reach
  // `BigInt(...)`. BigInt accepts radix prefixes (0x/0o/0b) but not a trailing
  // sign on them, so split the sign off first.
  const neg = str.startsWith("-");
  const digits = neg || str.startsWith("+") ? str.slice(1) : str;
  const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : radix === 2 ? "0b" : "";
  const magnitude = BigInt(prefix + digits);
  const exact = new SchemeExact(neg ? -magnitude : magnitude);
  if (forceInexact) {
    return exact.toInexact();
  }
  return exact;
}

/**
 * Type guard to check if a value is a SchemeNumeric (SchemeExact or SchemeInexact)
 */
export function isSchemeNumeric(value: unknown): value is SchemeNumeric {
  return value instanceof SchemeExact || value instanceof SchemeInexact;
}

/**
 * Check if a value is a numeric type (SchemeNumeric or JS primitive)
 */
export function isNumeric(value: unknown): boolean {
  return isSchemeNumeric(value) || typeof value === "number" || typeof value === "bigint";
}

// ============================================================================
// Type Checking Functions
// ============================================================================

/** Check if value is a native JS number or bigint */
export function isNativeNumber(n: unknown): n is number | bigint {
  return typeof n === "number" || typeof n === "bigint";
}

/** Check if value is a float (inexact real) */
export function isFloat(n: unknown): boolean {
  if (n instanceof SchemeInexact) {
    return true;
  }
  if (n instanceof SchemeExact) {
    return false;
  }
  return typeof n === "number" && n % 1 !== 0;
}

/**
 * Check if value is complex (has a non-zero imaginary part). arrival is reals-only,
 * so no representable value is ever complex — always #f. (Kept as a total guard so
 * callers don't need to special-case its removal.)
 */
export function isComplex(_n: unknown): boolean {
  return false;
}

/** Check if value is a rational (exact with denom != 1) */
export function isRational(n: unknown): boolean {
  if (n instanceof SchemeExact) {
    return n.denom !== 1n;
  }
  // Duck typing for legacy {num, denom} objects
  if (n && typeof n === "object" && "num" in n && "denom" in n) {
    return true;
  }
  return false;
}

/** Check if value is an integer */
export function isInteger(n: unknown): boolean {
  if (n instanceof SchemeExact) {
    return n.denom === 1n;
  }
  if (n instanceof SchemeInexact) {
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

/** Check if value is a big integer (exact integer) */
export function isBigInteger(n: unknown): boolean {
  if (n instanceof SchemeExact) {
    return n.denom === 1n;
  }
  return typeof n === "bigint";
}

AValue.registerBoxer("bigint", (v, p) => new SchemeExact(v as bigint, 1n, p));

// Safe-integer JS numbers route to exact — preserves precision through scheme
// arithmetic. Anything beyond MAX_SAFE_INTEGER would round on bigint conversion.
AValue.registerBoxer("number", (v, p) => {
  const n = v as number;
  return Number.isSafeInteger(n) ? new SchemeExact(BigInt(n), 1n, p) : new SchemeInexact(n, p);
});

// ============================================================================
// INTEROP BOUNDARIES
// ============================================================================
// War story (2026-05-28 audit): SchemeExact and SchemeInexact carry the
// numeric-tower behavior surface (isInteger/isRational/isReal getters plus
// the full arithmetic protocol on their prototypes). Numeric values are the
// densest object population in any inference computation — every arithmetic
// step creates a fresh instance. Symbol-to-field auto-resolution means each
// number is a potential probe point into the host numeric tower.
// Boundary-marking restricts interop member-access to own properties (num/denom for
// exact, real for inexact) which are the intended data surface; the
// methods (which expose tower internals and host-side bigint helpers) become
// blocked. The arithmetic ops scheme code actually uses (`+`, `*`, `floor`,
// …) live in the env bindings, not on these prototypes.
// ============================================================================
markInteropBoundary(SchemeExact);
markInteropBoundary(SchemeInexact);

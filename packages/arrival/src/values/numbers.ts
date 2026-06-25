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
import { CONSTANT_CTX, type RunContext } from "./primitives/RunContext.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./primitives/AValue.js";
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
// ExactNumber - Arbitrary Precision (integers and rationals)
// ============================================================================

export class AExact extends AValue {
  static [CLASS] = "number";
  readonly kind = "number" as const;

  readonly num: bigint;
  readonly denom: bigint;

  constructor(ctx: RunContext, num: bigint, denom: bigint = 1n, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    // Normalize: keep denom positive, reduce to lowest terms
    invariant(denom != 0n, "Division by zero");
    if (denom < 0n) {
      num = -num;
      denom = -denom;
    }
    const g = AExact.gcd(num < 0n ? -num : num, denom);
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

  withProvenance(p: ReadonlySet<number>): AExact {
    return new AExact(this.ctx, this.num, this.denom, p);
  }

  // String representation
  toString(): string {
    if (this.denom === 1n) {
      return this.num.toString();
    }
    return `${this.num}/${this.denom}`;
  }

  // Comparison (same-type)
  cmp(other: AExact): -1 | 0 | 1 {
    const diff = this.num * other.denom - other.num * this.denom;
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }

  equals(other: AExact): boolean {
    return this.num === other.num && this.denom === other.denom;
  }

  // Setoid (Fantasy Land). Exact ≡ exact ONLY — never equal to an inexact
  // (R7RS eqv?). structuralEqual / equal? consult this BEFORE their valueOf
  // fast-path, so this is what makes `(equal? 1 1.0)` correctly #f.
  // (algebras-in-entities migration — plan-2026-06-10-algebras-in-entities.md.)
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AExact && this.equals(other);
  }

  // Ord (Fantasy Land, extends Setoid). NUMERIC value comparison via schemeCompare
  // — `(<= 1 1.0)` is #t (cross-type via toReal), unlike the representation Setoid
  // above where exact ≠ inexact. NaN ⇒ schemeCompare returns NaN ⇒ `NaN <= 0` is #f,
  // so every relation derived from this collapses to #f on a NaN operand, exactly
  // like the numeric `<=` Operator. Non-number → false (Ord convention).
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return (
      (other instanceof AExact || other instanceof AInexact) &&
      schemeCompare(this, other, "<=") <= 0
    );
  }

  // Same-type arithmetic
  add(other: AExact): AExact {
    return new AExact(this.ctx, this.num * other.denom + other.num * this.denom, this.denom * other.denom);
  }

  sub(other: AExact): AExact {
    return new AExact(this.ctx, this.num * other.denom - other.num * this.denom, this.denom * other.denom);
  }

  mul(other: AExact): AExact {
    return new AExact(this.ctx, this.num * other.num, this.denom * other.denom);
  }

  div(other: AExact): AExact {
    return new AExact(this.ctx, this.num * other.denom, this.denom * other.num);
  }

  neg(): AExact {
    return new AExact(this.ctx, -this.num, this.denom);
  }

  abs(): AExact {
    return new AExact(this.ctx, this.num < 0n ? -this.num : this.num, this.denom);
  }

  inverse(): AExact {
    return new AExact(this.ctx, this.denom, this.num);
  }

  // Floor, ceiling, truncate, round - return exact integers
  floor(): AExact {
    if (this.denom === 1n) return this;
    const q = this.num / this.denom;
    // Floor: round toward negative infinity
    if (this.num < 0n && this.num % this.denom !== 0n) {
      return new AExact(this.ctx, q - 1n);
    }
    return new AExact(this.ctx, q);
  }

  ceiling(): AExact {
    if (this.denom === 1n) return this;
    const q = this.num / this.denom;
    // Ceiling: round toward positive infinity
    if (this.num > 0n && this.num % this.denom !== 0n) {
      return new AExact(this.ctx, q + 1n);
    }
    return new AExact(this.ctx, q);
  }

  truncate(): AExact {
    if (this.denom === 1n) return this;
    // Truncate: round toward zero
    return new AExact(this.ctx, this.num / this.denom);
  }

  round(): AExact {
    if (this.denom === 1n) return this;
    // Round to nearest, ties to even
    const q = this.num / this.denom;
    const r = this.num % this.denom;
    const absR = r < 0n ? -r : r;
    const halfDenom = this.denom / 2n;

    if (absR < halfDenom) {
      return new AExact(this.ctx, q);
    } else if (absR > halfDenom) {
      return new AExact(this.ctx, this.num < 0n ? q - 1n : q + 1n);
    } else {
      // Tie: round to even
      if (q % 2n === 0n) {
        return new AExact(this.ctx, q);
      }
      return new AExact(this.ctx, this.num < 0n ? q - 1n : q + 1n);
    }
  }

  // Integer operations (only valid when isInteger)
  mod(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "mod requires integers");
    return new AExact(this.ctx, this.num % other.num);
  }

  quotient(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "quotient requires integers");
    return new AExact(this.ctx, this.num / other.num);
  }

  gcd(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "gcd requires integers");
    return new AExact(this.ctx, 
      AExact.gcd(this.num < 0n ? -this.num : this.num, other.num < 0n ? -other.num : other.num),
    );
  }

  // Convert to inexact
  toInexact(): AInexact {
    return new AInexact(this.ctx, this.valueOf());
  }
}

// ============================================================================
// InexactNumber - Floating Point (reals only; complex axis omitted, see header)
// ============================================================================

export class AInexact extends AValue {
  static [CLASS] = "number";
  readonly kind = "number" as const;

  readonly real: number;

  constructor(ctx: RunContext, real: number, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
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

  private static floatToRational(x: number, tolerance: number = 1e-10): AExact {
    if (Number.isInteger(x)) {
      return new AExact(CONSTANT_CTX, BigInt(x));
    }

    // Simple approach: use decimal representation
    const str = x.toString();
    const dotIndex = str.indexOf(".");
    if (dotIndex === -1) {
      return new AExact(CONSTANT_CTX, BigInt(x));
    }

    const decimals = str.length - dotIndex - 1;
    const denom = 10n ** BigInt(decimals);
    const num = BigInt(str.replace(".", ""));
    return new AExact(CONSTANT_CTX, num, denom);
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

  withProvenance(p: ReadonlySet<number>): AInexact {
    return new AInexact(this.ctx, this.real, p);
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
  cmp(other: AInexact): -1 | 0 | 1 | number {
    if (this.real < other.real) return -1;
    if (this.real > other.real) return 1;
    if (this.real === other.real) return 0;
    return Number.NaN; // a NaN operand → incomparable
  }

  equals(other: AInexact): boolean {
    return this.real === other.real;
  }

  // Setoid (Fantasy Land). Inexact ≡ inexact ONLY. Object.is (not ===) so
  // reflexivity holds for NaN (`(eqv? +nan.0 +nan.0)` ⇒ #t) and ±0 stay
  // distinct — matching the legacy `equal` number-branch semantics.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AInexact && Object.is(this.real, other.real);
  }

  // Ord (Fantasy Land, extends Setoid). NUMERIC value comparison via schemeCompare
  // — same numeric/NaN semantics as SchemeExact's lte (cross-type, NaN ⇒ #f). The
  // representation Setoid above uses Object.is (so eqv? NaN is reflexive); this Ord
  // uses schemeCompare (so `(= +nan.0 +nan.0)` is #f) — two genuine comparisons.
  // Non-number → false (Ord convention).
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return (
      (other instanceof AExact || other instanceof AInexact) &&
      schemeCompare(this, other, "<=") <= 0
    );
  }

  // Same-type arithmetic (reals-only)
  add(other: AInexact): AInexact {
    return new AInexact(this.ctx, this.real + other.real);
  }

  sub(other: AInexact): AInexact {
    return new AInexact(this.ctx, this.real - other.real);
  }

  mul(other: AInexact): AInexact {
    return new AInexact(this.ctx, this.real * other.real);
  }

  div(other: AInexact): AInexact {
    // IEEE division directly: 1.0/0.0 = +inf.0, -1.0/0.0 = -inf.0, 0.0/0.0 = +nan.0.
    return new AInexact(this.ctx, this.real / other.real);
  }

  neg(): AInexact {
    return new AInexact(this.ctx, -this.real);
  }

  abs(): AInexact {
    return new AInexact(this.ctx, Math.abs(this.real));
  }

  // Floor, ceiling, truncate, round
  floor(): AInexact {
    return new AInexact(this.ctx, Math.floor(this.real));
  }

  ceiling(): AInexact {
    return new AInexact(this.ctx, Math.ceil(this.real));
  }

  truncate(): AInexact {
    return new AInexact(this.ctx, Math.trunc(this.real));
  }

  round(): AInexact {
    // Scheme rounds to even on ties
    const floored = Math.floor(this.real);
    const diff = this.real - floored;
    if (diff < 0.5) return new AInexact(this.ctx, floored);
    if (diff > 0.5) return new AInexact(this.ctx, floored + 1);
    // Tie: round to even
    if (floored % 2 === 0) return new AInexact(this.ctx, floored);
    return new AInexact(this.ctx, floored + 1);
  }

  // Transcendental functions (reals-only). sqrt of a negative DOORS — complex
  // results are not representable (see header / complexDoor).
  sqrt(): AInexact {
    if (this.real < 0) complexDoor();
    return new AInexact(this.ctx, Math.sqrt(this.real));
  }

  exp(): AInexact {
    return new AInexact(this.ctx, Math.exp(this.real));
  }

  log(): AInexact {
    return new AInexact(this.ctx, Math.log(this.real));
  }

  sin(): AInexact {
    return new AInexact(this.ctx, Math.sin(this.real));
  }

  cos(): AInexact {
    return new AInexact(this.ctx, Math.cos(this.real));
  }

  tan(): AInexact {
    return new AInexact(this.ctx, Math.tan(this.real));
  }

  pow(exponent: AInexact): AInexact {
    if (this.isZero) {
      // R7RS § 6.2.6: 0^0 = 1; 0^positive = 0; 0^negative is undefined
      // (division by zero).
      if (exponent.isZero) return new AInexact(this.ctx, 1);
      invariant(exponent.real > 0, "expt: 0 raised to a negative power (division by zero)");
      return new AInexact(this.ctx, 0);
    }
    return new AInexact(this.ctx, Math.pow(this.real, exponent.real));
  }

  // Convert to exact (if possible)
  toExact(): AExact {
    invariant(Number.isFinite(this.real), "Infinite number cannot be converted to exact");
    invariant(!Number.isNaN(this.real), "NaN cannot be converted to exact");
    // Convert float to rational
    return AInexact.floatToRational(this.real);
  }
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
export function toReal(n: ANumeric, _opName: string): number {
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
export function schemeCompare(a: ANumeric, b: ANumeric, opName: string): number {
  if (a instanceof AExact && b instanceof AExact) {
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
  div(a: AExact, b: AExact): ANumeric;

  /** How to handle square root of exact number */
  sqrt(a: AExact): ANumeric;
}

export interface InexactBehavior {
  /** How to handle square root of negative real */
  sqrtNegative(a: AInexact): ANumeric;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rational-enabled exact behavior: keep fractions
// ─────────────────────────────────────────────────────────────────────────────
export const RationalExact: ExactBehavior = {
  div(a: AExact, b: AExact): ANumeric {
    return a.div(b); // keeps as exact rational
  },

  sqrt(a: AExact): ANumeric {
    // sqrt of a negative is complex → doored (complex not supported).
    if (a.isNegative) {
      complexDoor();
    }
    if (a.isInteger) {
      const n = a.num;
      const root = bigintISqrt(n);
      if (root * root === n) {
        return new AExact(a.ctx, root);
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
  div(a: AExact, b: AExact): ANumeric {
    const result = a.div(b);
    if (result.isInteger) {
      return result;
    }
    // Can't represent as exact integer, demote to inexact
    return result.toInexact();
  },

  sqrt(a: AExact): ANumeric {
    if (a.isNegative) {
      complexDoor();
    }
    if (a.isInteger) {
      const n = a.num;
      const root = bigintISqrt(n);
      if (root * root === n) {
        return new AExact(a.ctx, root);
      }
    }
    return a.toInexact().sqrt();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Real-only inexact behavior: complex results are doored (the only behavior now)
// ─────────────────────────────────────────────────────────────────────────────
export const RealInexact: InexactBehavior = {
  sqrtNegative(_a: AInexact): ANumeric {
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

  fromInteger(n: bigint | number): AExact {
    return new AExact(CONSTANT_CTX, BigInt(n));
  }

  fromRational(num: bigint | number, denom: bigint | number): ANumeric {
    const exact = new AExact(CONSTANT_CTX, BigInt(num), BigInt(denom));
    // If rationals aren't supported, check if we need to demote
    if (this.config.exact === IntegerExact && !exact.isInteger) {
      return exact.toInexact();
    }
    return exact;
  }

  fromFloat(n: number): AInexact {
    return new AInexact(CONSTANT_CTX, n);
  }

  /**
   * Constructing a number with an imaginary part is DOORED — arrival is reals-only
   * (complexDoor). A zero imaginary part is just the real number.
   */
  fromComplex(real: number, imag: number): ANumeric {
    if (imag === 0) {
      return new AInexact(CONSTANT_CTX, real);
    }
    return complexDoor();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Coercion
  // ──────────────────────────────────────────────────────────────────────────

  /** Coerce to common type for binary operations */
  coerce(
    a: ANumeric,
    b: ANumeric,
  ): { kind: "exact"; a: AExact; b: AExact } | { kind: "inexact"; a: AInexact; b: AInexact } {
    if (a instanceof AExact && b instanceof AExact) {
      return { kind: "exact", a, b };
    }
    // One or both inexact: both become inexact
    const ia = a instanceof AInexact ? a : a.toInexact();
    const ib = b instanceof AInexact ? b : b.toInexact();
    return { kind: "inexact", a: ia, b: ib };
  }

  /** Convert inexact to exact */
  toExact(n: ANumeric): AExact {
    if (n instanceof AExact) return n;
    return n.toExact();
  }

  /** Convert exact to inexact */
  toInexact(n: ANumeric): AInexact {
    if (n instanceof AInexact) return n;
    return n.toInexact();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Binary operations with coercion
  // ──────────────────────────────────────────────────────────────────────────

  add(a: ANumeric, b: ANumeric): ANumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.add(c.b) : c.a.add(c.b);
  }

  sub(a: ANumeric, b: ANumeric): ANumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.sub(c.b) : c.a.sub(c.b);
  }

  mul(a: ANumeric, b: ANumeric): ANumeric {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.mul(c.b) : c.a.mul(c.b);
  }

  div(a: ANumeric, b: ANumeric): ANumeric {
    const c = this.coerce(a, b);
    if (c.kind === "exact") {
      return this.config.exact.div(c.a, c.b);
    }
    return c.a.div(c.b);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Unary operations
  // ──────────────────────────────────────────────────────────────────────────

  neg(a: ANumeric): ANumeric {
    return a.neg();
  }

  abs(a: ANumeric): ANumeric {
    return a.abs();
  }

  sqrt(a: ANumeric): ANumeric {
    if (a instanceof AExact) {
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
  compare(a: ANumeric, b: ANumeric): number {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.cmp(c.b) : c.a.cmp(c.b);
  }

  equals(a: ANumeric, b: ANumeric): boolean {
    const c = this.coerce(a, b);
    return c.kind === "exact" ? c.a.equals(c.b) : c.a.equals(c.b);
  }

  lessThan(a: ANumeric, b: ANumeric): boolean {
    return this.compare(a, b) < 0;
  }

  greaterThan(a: ANumeric, b: ANumeric): boolean {
    return this.compare(a, b) > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tower predicates
  // ──────────────────────────────────────────────────────────────────────────

  isInteger(n: ANumeric): boolean {
    return n.isInteger;
  }

  isRational(n: ANumeric): boolean {
    return n.isRational;
  }

  isReal(n: ANumeric): boolean {
    return n.isReal;
  }

  isComplex(n: ANumeric): boolean {
    return n.isComplex;
  }

  isExact(n: ANumeric): boolean {
    return n.isExact;
  }

  isZero(n: ANumeric): boolean {
    return n.isZero;
  }

  isPositive(n: ANumeric): boolean {
    return n.isPositive;
  }

  isNegative(n: ANumeric): boolean {
    return n.isNegative;
  }

  isNaN(n: ANumeric): boolean {
    return n.isNaN;
  }

  isFinite(n: ANumeric): boolean {
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
export function parseNumber(str: string, registry: NumberRegistry = schemeNumbers): ANumeric {
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
    const result = registry.fromRational(num, denom);
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

/**
 * Type guard to check if a value is a SchemeNumeric (SchemeExact or SchemeInexact)
 */
export function isSchemeNumeric(value: unknown): value is ANumeric {
  return value instanceof AExact || value instanceof AInexact;
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
  if (n instanceof AInexact) {
    return true;
  }
  if (n instanceof AExact) {
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
  if (n instanceof AExact) {
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

/** Check if value is a big integer (exact integer) */
export function isBigInteger(n: unknown): boolean {
  if (n instanceof AExact) {
    return n.denom === 1n;
  }
  return typeof n === "bigint";
}

AValue.registerBoxer("bigint", (_ctx, v, p) => new AExact(CONSTANT_CTX, v as bigint, 1n, p));

// Safe-integer JS numbers route to exact — preserves precision through scheme
// arithmetic. Anything beyond MAX_SAFE_INTEGER would round on bigint conversion.
AValue.registerBoxer("number", (_ctx, v, p) => {
  const n = v as number;
  return Number.isSafeInteger(n) ? new AExact(CONSTANT_CTX, BigInt(n), 1n, p) : new AInexact(CONSTANT_CTX, n, p);
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
markInteropBoundary(AExact);
markInteropBoundary(AInexact);

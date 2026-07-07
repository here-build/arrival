// AExact — arbitrary-precision exact number (integers and rationals). Extracted from numbers.ts
// (one-class-per-file, like the other value primitives). The AExact↔numbers.ts edges
// (lte→schemeCompare/toReal) and AExact↔AInexact (toInexact, cross-exactness ops) are BENIGN runtime
// cycles — method-body calls, nothing needed at module-eval (same shape as AJSArray↔AVector).
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { type RunContext } from "./RunContext.js";
import { CLASS } from "../../well-known-symbols.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";
import { schemeCompare } from "../numbers.js";
import { AInexact } from "./AInexact.js";

export class AExact extends AValue {
  static [INTEROP_BOUNDARY] = true;
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

  ["arrival/toJS"](): number | bigint {
    if (this.denom === 1n) {
      // Return bigint for integers if safe, otherwise number
      if (this.num >= BigInt(Number.MIN_SAFE_INTEGER) && this.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(this.num);
      }
      return this.num;
    }
    return this.valueOf();
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

  ["arrival/print"](): string {
    return this.toString();
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

  // Setoid — exact ≡ exact ONLY, never equal to inexact (R7RS eqv?). structuralEqual/equal?
  // consult this BEFORE the valueOf fast-path, which is what makes `(equal? 1 1.0)` #f.
  // (plan-2026-06-10-algebras-in-entities.md)
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AExact && this.equals(other);
  }

  // Ord (extends Setoid) — numeric value comparison via schemeCompare: `(<= 1 1.0)` is #t
  // (cross-type via toReal), unlike the representation Setoid above where exact ≠ inexact.
  // NaN ⇒ schemeCompare returns NaN ⇒ `NaN <= 0` is #f, so every derived relation collapses
  // to #f on a NaN operand, matching the numeric `<=` operator. Non-number → false.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return (other instanceof AExact || other instanceof AInexact) && schemeCompare(this, other) <= 0;
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
    return new AExact(
      this.ctx,
      AExact.gcd(this.num < 0n ? -this.num : this.num, other.num < 0n ? -other.num : other.num),
    );
  }

  // Convert to inexact
  toInexact(): AInexact {
    return new AInexact(this.ctx, this.valueOf());
  }
}

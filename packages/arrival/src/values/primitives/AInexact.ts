// AInexact — floating-point inexact number (reals only; complex axis omitted, see numbers.ts header).
// Safe-integer exact contract per docs/design-history/arrival-one-number-rework.md (§0.3 gates
// float→exact conversion below). AInexact↔AExact (toExact/floatToRational) and AInexact↔numbers.ts
// (complexDoor/schemeCompare) are benign runtime cycles — method-body calls, nothing at module-eval.
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import { CLASS } from "../../well-known-symbols.js";
import { complexDoor, schemeCompare } from "../numbers.js";
import { AExact } from "./AExact.js";
import { mintExact } from "../mint-numeric.js";
import type { SourceLocation } from "../../errors.js";

export class AInexact extends AValue {
  static [CLASS] = "number";
  readonly kind = "number" as const;

  readonly real: number;

  constructor(real: number, provenance: ReadonlySet<number> = EMPTY_PROVENANCE, location?: SourceLocation) {
    super(provenance, location);
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

  // Reals-only tower: every inexact value IS real — no imaginary part to test.
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

  private static floatToRational(ctx: RunContext, x: number, tolerance: number = 1e-10): AExact {
    if (Number.isInteger(x)) {
      return mintExact(ctx, x, 1, undefined, "inexact->exact");
    }

    // Simple approach: use decimal representation. `denom`/`num` route through
    // `mintExact` (not a bare `new AExact`) so a decimal expansion wide enough to leave
    // safe-integer range THROWS per §0.3, rather than silently truncating.
    const str = x.toString();
    const dotIndex = str.indexOf(".");
    if (dotIndex === -1) {
      return mintExact(ctx, x, 1, undefined, "inexact->exact");
    }

    const decimals = str.length - dotIndex - 1;
    const denom = 10 ** decimals;
    const num = Number(str.replace(".", ""));
    return mintExact(ctx, num, denom, undefined, "inexact->exact");
  }

  // Conversion to JS
  valueOf(): number {
    return this.real;
  }

  /** Mirrors the `schemeToJs` rosetta path (reals-only). */
  ["arrival/toJS"](): number {
    return this.real;
  }

  withProvenance(p: ReadonlySet<number>): AInexact {
    return new AInexact(this.real, p, this.location);
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

  ["arrival/print"](): string {
    return this.toString();
  }

  // Comparison. Returns NaN when either operand is a NaN inexact: R7RS § 6.2.6 —
  // every numeric comparison against +nan.0 is #f, so callers using
  // `cmp(b) === 0` / `< 0` / `> 0` all correctly yield #f (NaN compares false
  // against every relation). A `return 0` on the incomparable case would instead
  // make `(= +nan.0 x)` spuriously #t.
  cmp(other: AInexact): -1 | 0 | 1 | number {
    if (this.real < other.real) return -1;
    if (this.real > other.real) return 1;
    if (this.real === other.real) return 0;
    return Number.NaN; // a NaN operand → incomparable
  }

  equals(other: AInexact): boolean {
    return this.real === other.real;
  }

  // Setoid — inexact ≡ inexact ONLY. Object.is (not ===) so reflexivity holds for NaN
  // (`(eqv? +nan.0 +nan.0)` ⇒ #t) and ±0 stay distinct.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AInexact && Object.is(this.real, other.real);
  }

  // Ord (extends Setoid) — numeric value comparison via schemeCompare, same semantics as
  // AExact's lte (cross-type, NaN ⇒ #f). The Setoid above uses Object.is (eqv? NaN is
  // reflexive); this Ord uses schemeCompare (`(= +nan.0 +nan.0)` is #f) — two genuine
  // comparisons. Non-number → false.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return (other instanceof AExact || other instanceof AInexact) && schemeCompare(this, other) <= 0;
  }

  // Same-type arithmetic (reals-only)
  add(other: AInexact): AInexact {
    return new AInexact(this.real + other.real);
  }

  sub(other: AInexact): AInexact {
    return new AInexact(this.real - other.real);
  }

  mul(other: AInexact): AInexact {
    return new AInexact(this.real * other.real);
  }

  div(other: AInexact): AInexact {
    // IEEE division directly: 1.0/0.0 = +inf.0, -1.0/0.0 = -inf.0, 0.0/0.0 = +nan.0.
    return new AInexact(this.real / other.real);
  }

  neg(): AInexact {
    return new AInexact(-this.real);
  }

  abs(): AInexact {
    return new AInexact(Math.abs(this.real));
  }

  // Floor, ceiling, truncate, round
  floor(): AInexact {
    return new AInexact(Math.floor(this.real));
  }

  ceiling(): AInexact {
    return new AInexact(Math.ceil(this.real));
  }

  truncate(): AInexact {
    return new AInexact(Math.trunc(this.real));
  }

  round(): AInexact {
    // Scheme rounds to even on ties
    const floored = Math.floor(this.real);
    const diff = this.real - floored;
    if (diff < 0.5) return new AInexact(floored);
    if (diff > 0.5) return new AInexact(floored + 1);
    // Tie: round to even
    if (floored % 2 === 0) return new AInexact(floored);
    return new AInexact(floored + 1);
  }

  // Transcendental functions (reals-only). sqrt of a negative DOORS — complex
  // results are not representable (see header / complexDoor).
  sqrt(): AInexact {
    if (this.real < 0) complexDoor();
    return new AInexact(Math.sqrt(this.real));
  }

  exp(): AInexact {
    return new AInexact(Math.exp(this.real));
  }

  log(): AInexact {
    return new AInexact(Math.log(this.real));
  }

  sin(): AInexact {
    return new AInexact(Math.sin(this.real));
  }

  cos(): AInexact {
    return new AInexact(Math.cos(this.real));
  }

  tan(): AInexact {
    return new AInexact(Math.tan(this.real));
  }

  pow(exponent: AInexact): AInexact {
    if (this.isZero) {
      // R7RS § 6.2.6: 0^0 = 1; 0^positive = 0; 0^negative is undefined
      // (division by zero).
      if (exponent.isZero) return new AInexact(1);
      invariant(exponent.real > 0, "expt: 0 raised to a negative power (division by zero)");
      return new AInexact(0);
    }
    return new AInexact(Math.pow(this.real, exponent.real));
  }

  // Convert to exact (if possible)
  toExact(): AExact {
    invariant(Number.isFinite(this.real), "Infinite number cannot be converted to exact");
    invariant(!Number.isNaN(this.real), "NaN cannot be converted to exact");
    // Convert float to rational
    return AInexact.floatToRational(CONSTANT_CTX, this.real);
  }
}

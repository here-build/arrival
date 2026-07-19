// AExact — exact number (integers and rationals) over SAFE-INTEGER `number` components.
// Extracted from numbers.ts (one-class-per-file, like the other value primitives). Per
// docs/design-history/arrival-one-number-rework.md §2.0/§2.1 ("RATIO with
// crash-on-overflow"): `num`/`denom` are both plain JS `number`s, each always satisfying
// `Number.isSafeInteger` (the safe-operand invariant, §0.2) — never `bigint`. Given safe
// operands, IEEE double arithmetic on integers is exact whenever the true result is in
// safe range, and a true result ≥ 2^53 can never round back INTO safe range — so a
// post-op `Number.isSafeInteger` check is a sound exactness gate for the closed `+ − ×`
// algebra (§0.2). A result whose num or denom would leave safe range THROWS (§0.3,
// `ExactOverflowError` via `../mint-numeric.js`) — never silently coerces to inexact.
//
// The AExact↔numbers.ts edges (lte→schemeCompare/toReal) and AExact↔AInexact (toInexact,
// cross-exactness ops) are BENIGN runtime cycles — method-body calls, nothing needed at
// module-eval (same shape as AJSArray↔AVector). AExact↔mint-numeric.ts is the same
// pattern (see that file's header): mint-numeric constructs `new AExact` only inside
// function bodies, this file calls mint-numeric's helpers only inside method bodies.
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { type RunContext } from "./RunContext.js";
import { CLASS } from "../../well-known-symbols.js";
import { schemeCompare } from "../numbers.js";
import { AInexact } from "./AInexact.js";
import {
  checkedAdd,
  checkedMul,
  checkedSub,
  debugCrossCheckRational,
  isNumericDebugEnabled,
  mintExact,
} from "../mint-numeric.js";

export class AExact extends AValue {
  static [CLASS] = "number";
  readonly kind = "number" as const;

  readonly num: number;
  readonly denom: number;

  constructor(ctx: RunContext, num: number, denom: number = 1, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    invariant(denom !== 0, "Division by zero");
    // Internal invariant, NOT the overflow door: a caller minting exact arithmetic must
    // have pre-checked every intermediate via checkedMul/checkedAdd/checkedSub (or gone
    // through mintExact) BEFORE reaching this constructor. Landing here with an already-
    // unsafe component is an arrival bug (a gate leak), not a program-level event — hence
    // a plain invariant, never `ExactOverflowError`.
    invariant(
      Number.isSafeInteger(num),
      `AExact: num ${num} is not a safe integer — the caller must check via checkedMul/checkedAdd/checkedSub (or mintExact) before constructing`,
    );
    invariant(
      Number.isSafeInteger(denom),
      `AExact: denom ${denom} is not a safe integer — the caller must check via checkedMul/checkedAdd/checkedSub (or mintExact) before constructing`,
    );
    // Normalize: keep denom positive, reduce to lowest terms.
    if (denom < 0) {
      num = -num;
      denom = -denom;
    }
    const g = AExact.gcd(num, denom);
    const normNum = num / g;
    // Exact -0 is unconstructible (Number.isSafeInteger(-0) is true, so the check above
    // doesn't catch it) — normalize the -0 that `0 / g` (g>0) can produce (§0.6).
    this.num = normNum === 0 ? 0 : normNum;
    this.denom = denom / g;
  }

  // Tower predicates - check mathematical properties
  get isInteger(): boolean {
    return this.denom === 1;
  }

  get isRational(): boolean {
    return true; // all exact numbers are rational
  }

  get isReal(): boolean {
    return true; // all rationals are real
  }

  get isComplex(): boolean {
    return true; // real ⊂ complex; predicate stays total
  }

  // Exactness
  get isExact(): boolean {
    return true;
  }

  // Value checks
  get isZero(): boolean {
    return this.num === 0;
  }

  get isPositive(): boolean {
    return this.num > 0;
  }

  get isNegative(): boolean {
    return this.num < 0;
  }

  get isNaN(): boolean {
    return false; // exact numbers are never NaN
  }

  get isFinite(): boolean {
    return true; // exact numbers are always finite
  }

  /** Euclid over safe-int `number`s. `%` never grows the magnitude past its larger
   *  operand, so no intermediate here can overflow given safe-int inputs — no checked
   *  helper needed. */
  private static gcd(a: number, b: number): number {
    a = a < 0 ? -a : a;
    b = b < 0 ? -b : b;
    while (b !== 0) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  // Conversion to JS
  valueOf(): number {
    return this.num / this.denom;
  }

  /** Egress divides (§2.0's projection∘borrow law, same as nil-as-array): a `bigint`
   *  result is no longer possible — every `AExact.num` is already a safe-int `number` by
   *  construction, so the integer arm is a bare return, and the rational arm's float
   *  division is the intentional face (`toJS(1/3)` = `0.333…`). */
  ["arrival/toJS"](): number {
    if (this.denom === 1) {
      return this.num;
    }
    return this.valueOf();
  }

  withProvenance(p: ReadonlySet<number>): AExact {
    return new AExact(this.ctx, this.num, this.denom, p);
  }

  // String representation
  toString(): string {
    if (this.denom === 1) {
      return this.num.toString();
    }
    return `${this.num}/${this.denom}`;
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  // Comparison (same-type). Cross-multiplies for exactness, but — unlike arithmetic —
  // a comparison never crashes on overflow: if `this.num*other.denom` (or the
  // subtraction) would leave safe range, the comparison falls back to a float
  // (`valueOf()`) compare. That's sound because a comparator only needs to answer
  // ORDER, never reconstruct a value — a monotonic float approximation of two safe-int
  // rationals is a correct comparator even where the exact cross-multiplied integer
  // can't be formed (§2.1 schemeCompare note; the checked-intermediate law still
  // applies to the fast path, it just degrades to floats instead of throwing).
  cmp(other: AExact): -1 | 0 | 1 {
    const left = this.num * other.denom;
    const right = other.num * this.denom;
    if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) {
      const diff = left - right;
      if (Number.isSafeInteger(diff)) {
        if (diff < 0) return -1;
        if (diff > 0) return 1;
        return 0;
      }
    }
    const lv = this.valueOf();
    const rv = other.valueOf();
    if (lv < rv) return -1;
    if (lv > rv) return 1;
    return 0;
  }

  equals(other: AExact): boolean {
    return this.num === other.num && this.denom === other.denom;
  }

  // Setoid — exact ≡ exact ONLY, never equal to inexact (R7RS eqv?). structuralEqual/equal?
  // consult this BEFORE the valueOf fast path, which is what makes `(equal? 1 1.0)` #f.
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

  // Same-type arithmetic. Each cross-multiplied intermediate (the `ad`/`bc` cross terms,
  // the `ad+bc`/`ad-bc` numerator, the `bd` denominator) is checked BEFORE the
  // gcd-normalizing constructor runs (§0.3) — mintExact's own re-check is defense in
  // depth, not the primary gate, because a float product that already silently
  // overflowed can round back to something that LOOKS safe by the time mintExact sees
  // it. The DEBUG belt (ARRIVAL_NUMERIC_DEBUG) cross-checks the reduced result against
  // BigInt arithmetic — zero cost when the flag is unset.
  add(other: AExact): AExact {
    const num = checkedAdd(
      checkedMul(this.num, other.denom, "exact +"),
      checkedMul(other.num, this.denom, "exact +"),
      "exact +",
    );
    const denom = checkedMul(this.denom, other.denom, "exact +");
    const result = mintExact(this.ctx, num, denom, undefined, "exact +");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("add", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  sub(other: AExact): AExact {
    const num = checkedSub(
      checkedMul(this.num, other.denom, "exact -"),
      checkedMul(other.num, this.denom, "exact -"),
      "exact -",
    );
    const denom = checkedMul(this.denom, other.denom, "exact -");
    const result = mintExact(this.ctx, num, denom, undefined, "exact -");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("sub", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  mul(other: AExact): AExact {
    const num = checkedMul(this.num, other.num, "exact *");
    const denom = checkedMul(this.denom, other.denom, "exact *");
    const result = mintExact(this.ctx, num, denom, undefined, "exact *");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("mul", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  div(other: AExact): AExact {
    const num = checkedMul(this.num, other.denom, "exact /");
    const denom = checkedMul(this.denom, other.num, "exact /");
    // Zero-denominator (i.e. dividing by exact zero) still throws — via the AExact
    // constructor's own "Division by zero" invariant inside mintExact, unrelated to the
    // overflow door. R7RS: exact `(/ x 0)` errors; only `0.0` division is IEEE `inf`/`nan`.
    const result = mintExact(this.ctx, num, denom, undefined, "exact /");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("div", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  neg(): AExact {
    return mintExact(this.ctx, -this.num, this.denom, undefined, "exact negate");
  }

  abs(): AExact {
    return mintExact(this.ctx, this.num < 0 ? -this.num : this.num, this.denom, undefined, "exact abs");
  }

  inverse(): AExact {
    return mintExact(this.ctx, this.denom, this.num, undefined, "exact inverse");
  }

  // Floor, ceiling, truncate, round - return exact integers. `r`/`q` below are computed
  // via `%` then exact subtraction-then-division (never `Math.trunc(num/denom)` directly)
  // so the quotient is the TRUE truncated integer: `num - r` is exactly divisible by
  // `denom` by construction, and IEEE division of two doubles whose true quotient is
  // itself an integer in safe range is correctly rounded to exactly that integer.
  floor(): AExact {
    if (this.denom === 1) return this;
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    // Floor: round toward negative infinity
    if (this.num < 0 && r !== 0) {
      return mintExact(this.ctx, q - 1, 1, undefined, "exact floor");
    }
    return mintExact(this.ctx, q, 1, undefined, "exact floor");
  }

  ceiling(): AExact {
    if (this.denom === 1) return this;
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    // Ceiling: round toward positive infinity
    if (this.num > 0 && r !== 0) {
      return mintExact(this.ctx, q + 1, 1, undefined, "exact ceiling");
    }
    return mintExact(this.ctx, q, 1, undefined, "exact ceiling");
  }

  truncate(): AExact {
    if (this.denom === 1) return this;
    // Truncate: round toward zero
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    return mintExact(this.ctx, q, 1, undefined, "exact truncate");
  }

  round(): AExact {
    if (this.denom === 1) return this;
    // Round to nearest, ties to even
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    const absR = r < 0 ? -r : r;
    // Mirrors the old bigint `this.denom / 2n` truncating division exactly: dividing a
    // safe-int by 2 is always exact in a double (a pure exponent shift), so
    // `Math.trunc` here reproduces bigint `/2n` bit-for-bit, odd-denominator quirks
    // included — no behavior drift from the flat/bigint variant.
    const halfDenom = Math.trunc(this.denom / 2);

    if (absR < halfDenom) {
      return mintExact(this.ctx, q, 1, undefined, "exact round");
    } else if (absR > halfDenom) {
      return mintExact(this.ctx, this.num < 0 ? q - 1 : q + 1, 1, undefined, "exact round");
    } else {
      // Tie: round to even
      if (q % 2 === 0) {
        return mintExact(this.ctx, q, 1, undefined, "exact round");
      }
      return mintExact(this.ctx, this.num < 0 ? q - 1 : q + 1, 1, undefined, "exact round");
    }
  }

  // Integer operations (only valid when isInteger)
  mod(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "mod requires integers");
    return mintExact(this.ctx, this.num % other.num, 1, undefined, "exact modulo");
  }

  quotient(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "quotient requires integers");
    const r = this.num % other.num;
    const q = (this.num - r) / other.num;
    return mintExact(this.ctx, q, 1, undefined, "quotient");
  }

  gcd(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "gcd requires integers");
    return mintExact(this.ctx, AExact.gcd(this.num, other.num), 1, undefined, "gcd");
  }

  // Convert to inexact
  toInexact(): AInexact {
    return new AInexact(this.ctx, this.valueOf());
  }
}

/**
 * Scheme Numeric Tower Implementation (R7RS-small §6.2: integer ⊂ rational ⊂ real,
 * exact/inexact). Two classes based on exactness, both always present:
 * - AExact: safe-integer RATIO (`number` num/denom, both always `Number.isSafeInteger`)
 *   — represents integers AND rationals (denom=1 is the integer case). Per
 *   docs/design-history/arrival-one-number-rework.md §2.0/§2.1: a result whose
 *   num/denom would leave safe range THROWS (crash-on-overflow), never silently
 *   coerces — see `values/mint-numeric.ts` for the mint choke-point.
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
import { CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./primitives/AValue.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { ComplexNumberError, ParseError } from "../errors.js";

// ============================================================================
// Complex-subsetting door (errors-as-doors)
// ============================================================================

/**
 * arrival omits the complex tower entirely (R7RS § 6.2.3 permits this); the door
 * RECOGNIZES the omitted feature and explains the real-only alternative, rather
 * than silently misparsing or returning a wrong value. Matches arrival's
 * %purity-door discipline. See `ComplexNumberError` (errors.ts) for the message.
 */
export function complexDoor(): never {
  throw new ComplexNumberError();
}

// ============================================================================
// Type Definitions
// ============================================================================

export type ANumeric = AExact | AInexact;

/**
 * Integer square root of a non-negative safe-integer `number` (`exact-integer-sqrt`'s
 * core, §2.1 — replaces the old `bigintISqrt`; the bigint-Newton reason for existing is
 * gone under the safe-int invariant, since `n` can never exceed
 * `Number.MAX_SAFE_INTEGER` in the first place). `Math.sqrt` gives a float estimate that
 * can be off by one at the boundary due to double rounding; the two correction loops
 * below walk to the true integer sqrt. Every intermediate (`r*r`, `(r+1)*(r+1)`) stays
 * safe by construction: `r ≤ sqrt(n) ≤ sqrt(MAX_SAFE_INTEGER)`, so `r*r ≤ n` always.
 * Returns r with r*r ≤ n < (r+1)*(r+1).
 */
export function exactISqrt(n: number): number {
  invariant(Number.isSafeInteger(n) && n >= 0, "isqrt: requires a non-negative safe integer");
  if (n < 2) return n;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
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
    return n.num / n.denom;
  }
  return n.real;
}

/**
 * Three-way comparison of two reals: -1 / 0 / 1, or NaN if incomparable
 * (either operand is a NaN inexact). The exact/exact case routes through
 * `AExact.cmp` — a safe-int cross-multiply compare, with a float fallback for the
 * (now rare) case where the cross-multiplied intermediate itself would overflow
 * (see `AExact.cmp`'s own doc: a comparator only needs ORDER, so a monotonic float
 * approximation is a sound comparator even where the exact integer product can't be
 * formed). Only when at least one side is inexact do we fall back to `toReal`, where
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

const PARSE_SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const PARSE_SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);

/** Parses a magnitude via BigInt (so arbitrarily many digits are read exactly, unlike
 *  `parseInt`/`Number()` which silently round past 2^53) then gates it against the
 *  safe-integer invariant (§0.3): a literal too large for exact THROWS `ParseError`
 *  ("write it inexact") rather than either truncating or minting an impossible
 *  bigint-backed `AExact`. `original` is the pre-parse source slice, for the message. */
function parseSafeIntLiteral(magnitude: bigint, original: string): number {
  if (magnitude > PARSE_SAFE_MAX || magnitude < PARSE_SAFE_MIN) {
    throw new ParseError(
      `exact literal ${original} exceeds safe-integer range — write it inexact (e.g. append a decimal point, or use #i) if approximation is acceptable`,
    );
  }
  return Number(magnitude);
}

// A public, host-facing string→number utility (re-exported off `index.ts`) — distinct
// from `reader/parsing.ts`'s near-namesake `parse_rational`/`parse_integer`/
// `parse_float`, which ARE dual-use (called live by `string->number`). No span/crossing
// concept applies to a bare host utility, so it mints against `CONSTANT_CTX`; a live
// rosetta/MCP caller should pass the crossing's own ctx rather than leaning on this
// default.
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
    const num = parseSafeIntLiteral(BigInt(rationalMatch[1]), str);
    const denom = parseSafeIntLiteral(BigInt(rationalMatch[2]), str);
    const result = new AExact(CONSTANT_CTX, num, denom);
    if (forceInexact) {
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

  // Handle integer. Parse the magnitude via BigInt so digits beyond 2^53 are read
  // exactly — `parseInt` would round to a lossy double before the safe-range gate ever
  // saw the true value. BigInt accepts radix prefixes (0x/0o/0b) but not a trailing
  // sign on them, so split the sign off first. `parseSafeIntLiteral` throws
  // `ParseError` (never silently truncates/coerces) if the literal exceeds safe range.
  const neg = str.startsWith("-");
  const digits = neg || str.startsWith("+") ? str.slice(1) : str;
  const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : radix === 2 ? "0b" : "";
  const magnitudeBig = BigInt(prefix + digits);
  const exactNum = parseSafeIntLiteral(neg ? -magnitudeBig : magnitudeBig, str);
  const exact = new AExact(CONSTANT_CTX, exactNum);
  if (forceInexact) {
    return exact.toInexact();
  }
  return exact;
}


// ============================================================================
// Type Checking Functions
// ============================================================================

/**
 * Check if value has a non-zero imaginary part. arrival is reals-only, so no
 * representable value ever does — always #f. NOT the `complex?` predicate: that
 * routes through the number classes' own `isComplex` getters, which answer #t for
 * every real (real ⊂ complex — see the file header).
 */
export function isComplex(_n: unknown): boolean {
  return false;
}

export function isInteger(n: unknown): n is AExact | bigint | number {
  if (n instanceof AExact) {
    return n.denom === 1;
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
// into the host numeric tower. The FAMILY RULE in interop-access.ts (own
// `[CLASS]` brand on the constructor = boundary; no per-class stamp) restricts
// interop member-access to own properties (num/denom for exact, real for
// inexact) — the intended data surface — blocking the tower-internals methods.
// The arithmetic ops scheme code actually uses (`+`, `*`, `floor`, …) live in
// env bindings, not on these prototypes.
// ============================================================================

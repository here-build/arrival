/**
 * Bridge - connects the Operator/Profunctor system with the Scheme runtime.
 *
 * This module provides:
 * 1. Strict numeric coercion into the SchemeExact/SchemeInexact tower (`coerceNumeric`)
 * 2. Wrapped operators that work with boxed Scheme values
 * 3. Drop-in replacements for global_env numeric operations
 */

import { SPECULATE } from "./well-known-symbols.js";
import { R7RSError, R7RSReadError, R7RSFileError, RaisedException } from "./errors.js";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import { AValue, unionProvenance } from "./values/primitives/AValue.js";
import { isBridgeInitialized, markBridgeInitialized, setBootstrapComplete } from "./boot.js";
import { EnvCapability } from "./common/capability.js";
import { assembleEnv } from "./common/kernel.js";
import { BASE_PACKS } from "./env/base-packs.js";
import type { EvalSchemeInto, SchemeEnv } from "./common/scheme-env.js";
import { AHalfBaked, type Interval, is_half_baked } from "./values/primitives/AHalfBaked.js";
import type { Environment } from "./Environment.js";
import { schemeFalse, schemeTrue } from "./values/primitives/ABool.js";
import { coerceNumeric, type AOrd, isOrd, isSchemeNumber, ORD_REL, nilOrderCompare, withInputProvenance } from "./values/op-helpers.js";
import { isStrict } from "./eval/evaluator.js";
// Value-domain primitive clusters — each is the carved-out source of truth for one
// R7RS domain (chars/strings/lists/vectors/bytevectors + combinators + equality).
// They are no longer spread into `wrappedOps`: `initBridge` ASSEMBLES them onto
// `global_env` as live capability packs (see `NATIVE_PACKS`). `wrappedOps` keeps only
// the numeric core + exception machinery bridge.ts is named for (the
// Operator/Profunctor↔Scheme bridge).
import { NATIVE_PACKS } from "./env/native-packs.js";
import { env as userEnv, exec, global_env } from "./stdlib.js";
import { inferenceEnv } from "./inference-env.js";
import { AString } from "./values/primitives/AString.js";
import type { Codec, Operator } from "./membrane.js";
import type { ANumeric } from "./values/numbers.js";
import { AExact } from "./values/primitives/AExact.js";
import { AInexact } from "./values/primitives/AInexact.js";
import * as ops from "./operators/index.js";
// Import directly from source files to avoid circular dependency during init
import { APair } from "./values/primitives/APair.js";
import { nil } from "./values/primitives/ANil.js";
import { type } from "./utils/typecheck.js";
import { Values } from "./values/primitives/Values.js";
import invariant from "tiny-invariant";
import "./errors.js";
// Import global environment for initBridge - this is safe because bridge.ts
// doesn't get imported during lips.ts initialization

// The allocation cap, value-type coercions (charValue/stringValue/toIndex/
// asVector/asBytevector), eqv, coerceNumeric/isSchemeNumber, and the provenance
// stamp (withInputProvenance) now live in the leaf `op-helpers.ts` — shared with
// the value-domain cluster packs. Re-exported below for the external importers
// (evaluator, tests) that still reach for them via `bridge.js`.
export { coerceNumeric } from "./values/op-helpers.js";

// R7RSError / R7RSReadError / R7RSFileError / RaisedException relocated to errors.ts (the single error home).

/**
 * Wrap an Operator to work with LIPS values.
 * Returns a function that converts args from LIPS, calls the operator, and converts result back.
 *
 * Provenance flows through every builtin routed here. Concretely: when downstream
 * Scheme like `(if (< (length cls) 3) ...)` branches, the boolean produced by `<`
 * must remember it was derived from `cls` so the consumer can attribute behavior
 * back to that source. Comparison/arithmetic results are produced by `op.call`,
 * which has no knowledge of the input AValues — stamping has to happen at this
 * boundary or it would have to be added (and could be forgotten) in ~50 operator
 * sites. Doing it once here covers `+ - * /`, the six comparisons, gcd/lcm,
 * sqrt/log/trig, bitwise, and the dozens of r7rs entries under wrappedOps.
 *
 * Empty-provenance short-circuit: most call sites are parser-produced literals
 * (`(+ 1 2)`) where neither argument carries any source ids. The union is empty,
 * `withProvenance` would just clone, and the clone is observationally identical —
 * skip the allocation. The `instanceof AValue` guard on `result` also covers
 * operators whose `op.call` returns raw JS (no provenance surface to stamp).
 *
 * Comparison-op bool boxing: operators declared with `out: Bool` (numEq/lt/gt/
 * lte/gte, zero?/positive?/negative?/odd?/even?, finite?/infinite?/nan?, the
 * type predicates) produce raw JS `true|false` via `Bool.fromJS = v => v`
 * (membrane.ts:456-462). Without the boxing branch below, `(if (< x 5) ...)`
 * loses lineage at `restrictControlFlowProvenance` (evaluator.ts:629 —
 * `predicate instanceof AValue === false`), because most real `if`/`cond`
 * predicates ARE comparisons. We only box when provenance is non-empty: with
 * empty provenance, the boxed singletons would survive into call sites that
 * still rely on raw `=== false` / `!== false` checks (the same landmine
 * `withInputProvenance` in lips.ts:2042-2054 calls out as sealed).
 */
export function wrapOperator<In extends any[], InRest extends Codec<any, any> | undefined, Out extends Codec<any, any>>(
  op: Operator<In, InRest, Out>,
): (...args: unknown[]) => unknown {
  // Why stamp coerceNumeric failures HERE: a type error from coercion (e.g. a
  // string passed to `*`) travels up through several catch paths that swallow or
  // rewrap it, and a downstream `env.get(first)` retry leaves only the outer
  // form's name on the message — so the symptom mis-presents as an unbound-symbol
  // lookup failure on an unrelated operator. This boundary is the only frame that
  // holds both pieces needed to name the real cause (op.name here, type() on the
  // args). The original TypeError rides along via `cause` so the membrane stack
  // still traces the converter's invariant. We don't catch op.call itself —
  // operator-internal failures already carry `op.name` (see membrane.ts).
  //
  // The synchronous numeric core: convert args, apply the operator, stamp
  // provenance. Factored out so the speculative path can run it either eagerly
  // or after forcing a HalfBaked carrier.
  const applyNumeric = (callArgs: unknown[]): unknown => {
    const provenance = unionProvenance(callArgs.filter((a): a is AValue => a instanceof AValue));
    let converted: ANumeric[];
    try {
      converted = callArgs.map(coerceNumeric);
    } catch (cause) {
      // Find the first non-numeric arg so the error names what actually failed,
      // not just "some arg." Mirror isSchemeNumber's contract — anything it
      // rejects is what coerceNumeric would have thrown on.
      const badIndex = callArgs.findIndex((a) => !isSchemeNumber(a));
      const typeNames = callArgs.map(type).join(", ");
      const detail = badIndex >= 0 ? `argument ${badIndex} is ${type(callArgs[badIndex])}` : "argument type mismatch";
      throw new TypeError(`Cannot apply ${op.name} to (${typeNames}): ${detail}`, { cause });
    }
    const result: unknown = op.call(converted);
    if (provenance.size > 0) {
      if (result instanceof AValue) return result.withProvenance(provenance);
      // Box JS bool coming out of comparison/predicate operators (Bool codec).
      // Empty-provenance path returns raw bool to keep find/`!== false` callers alive.
      if (typeof result === "boolean") {
        return (result ? schemeTrue : schemeFalse).withProvenance(provenance);
      }
    }
    return result;
  };

  // Use Object.defineProperty to set the name from operator
  const fn = function (...args: unknown[]): unknown {
    // ── Tier 2 speculative evaluation ──────────────────────────────────────
    // A `HalfBaked` reaches this wrapper ONLY for the comparison ops marked
    // `__speculate__` below (the dispatch choke forces it for every other
    // numeric op). For a comparison against a still-filling cardinality
    // interval we can often decide the result EARLY — that early-decision
    // promise is what collapses the enclosing `if`. If we can't decide here
    // (both operands HalfBaked, undecidable interval at call time, etc.), we
    // force the carrier(s) and run the normal numeric path — never wrong,
    // just not early. `args.some(is_half_baked)` is only ever true here.
    if (args.some(is_half_baked)) {
      const decided = SPECULATIVE_OPS.has(op.name) ? speculativeCompare(op.name, args) : undefined;
      if (decided !== undefined) return decided;
      return Promise.all(args.map((a) => (is_half_baked(a) ? a.force() : a))).then(applyNumeric);
    }
    return applyNumeric(args);
  };
  // Mark the comparison ops so the dispatch choke leaves their HalfBaked args
  // unforced — this wrapper reads the interval instead of a settled value.
  if (SPECULATIVE_OPS.has(op.name)) {
    (fn as { [SPECULATE]?: boolean })[SPECULATE] = true;
  }
  Object.defineProperty(fn, "name", { value: op.name });
  return fn;
}

// ════════════════════════════════════════════════════════════════════════════
// Tier 2 speculative comparison against a HalfBaked cardinality interval.
// See docs/package-specific/arrival-scheme/speculative-evaluation-promise-functor-2026-06-05.md.
// ════════════════════════════════════════════════════════════════════════════

/** The comparison ops that can decide early against a narrowing interval. */
const SPECULATIVE_OPS = new Set(["=", "<", ">", "<=", ">="]);

/** `(op k hb)` ⟺ `(reflect[op] hb k)` — used to normalize the HalfBaked to the left. */
const REFLECT: Record<string, string> = { ">=": "<=", "<=": ">=", ">": "<", "<": ">", "=": "=" };

/**
 * The early-decision verdict for `(op interval k)`: returns a definite boolean
 * the instant the interval is decisive, or `undefined` to keep waiting. Sound by
 * construction — every branch only fires when the interval ENTIRELY lies on one
 * side of `k`, so the answer cannot change as the interval narrows further.
 */
function verdictFor(op: string, k: number): ((iv: Interval) => boolean | undefined) | undefined {
  switch (op) {
    case ">=":
      return (iv) => (iv.lo >= k ? true : iv.hi < k ? false : undefined);
    case ">":
      return (iv) => (iv.lo > k ? true : iv.hi <= k ? false : undefined);
    case "<=":
      return (iv) => (iv.hi <= k ? true : iv.lo > k ? false : undefined);
    case "<":
      return (iv) => (iv.hi < k ? true : iv.lo >= k ? false : undefined);
    case "=":
      return (iv) => (iv.lo === iv.hi && iv.lo === k ? true : iv.hi < k || iv.lo > k ? false : undefined);
    default:
      return undefined;
  }
}

/** Best-effort numeric extraction of the concrete operand; undefined ⇒ can't speculate. */
function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof AValue && typeof (v as { valueOf?: () => unknown }).valueOf === "function") {
    const n = Number((v as { valueOf: () => unknown }).valueOf());
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * Try to decide a binary comparison where exactly one operand is a number-domain
 * `HalfBaked` (a narrowing cardinality interval) and the other is a concrete
 * number. Returns an early-decision `Promise<boolean>` (provenance-stamped to
 * match the eager path), or `undefined` when speculation doesn't apply — caller
 * then forces and runs normally.
 */
function speculativeCompare(name: string, args: unknown[]): unknown | undefined {
  if (args.length !== 2) return undefined;
  const [a, b] = args;
  const aHB = is_half_baked(a);
  const bHB = is_half_baked(b);
  if (aHB === bHB) return undefined; // need exactly one HalfBaked operand
  const hb = (aHB ? a : b) as AHalfBaked;
  const k = toNumber(aHB ? b : a);
  if (k === undefined) return undefined;
  // Normalize so the interval is on the left of the operator.
  const verdict = verdictFor(aHB ? name : REFLECT[name], k);
  if (!verdict) return undefined;
  const provenance = unionProvenance(args.filter((x): x is AValue => x instanceof AValue));
  return hb
    .decide(verdict)
    .then((bool) => (provenance.size > 0 ? (bool ? schemeTrue : schemeFalse).withProvenance(provenance) : bool));
}

/**
 * Create a type predicate that doesn't throw on non-numbers
 */
function makeTypePredicate(name: string, predicate: (n: ANumeric) => boolean): unknown {
  const fn = (value: unknown): boolean => {
    if (!isSchemeNumber(value)) {
      return false;
    }
    try {
      const converted = coerceNumeric(value);
      return predicate(converted);
    } catch {
      return false;
    }
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

// The FL-Ord derivation (`isOrd` / `ORD_REL` / `deriveOrd`) lives in op-helpers —
// shared with the chars + strings clusters, whose `char<?` / `string<?` families
// ARE `deriveOrd` chains. `wrapOrd` stays here: it wraps a NUMERIC operator with
// the FL-Ord fallback, so it belongs with the numeric bridge core.
function wrapOrd(numeric: (...a: unknown[]) => unknown, sym: "<" | ">" | "<=" | ">="): (...a: unknown[]) => unknown {
  const rel = ORD_REL[sym];
  // FL-Ord only intercepts NON-NUMERIC ordered entities (string/char/symbol/DateTime/…).
  // A number is excluded even though it now carries a `arrival/tagless-final/lte` (numbers' Ord is
  // numeric): ORD_REL is a TOTAL-order shortcut (`<` ≡ `!lte(b,a)`) that is WRONG for the
  // partial numeric order (NaN-incomparable ⇒ would yield #t for `(< +nan.0 1)`), and the
  // numeric Operator additionally carries provenance + the speculative early-collapse the
  // FL branch can't. So numbers fall through to `numeric(...)`, exactly as before numbers
  // gained an Ord — the invariant this branch always relied on, now made explicit.
  const isOrdEntity = (x: unknown): x is AOrd => isOrd(x) && !isSchemeNumber(x);
  const fn = (...args: unknown[]): unknown => {
    if (args.length >= 2 && args.some(isOrdEntity)) {
      for (let i = 0; i < args.length - 1; i++) {
        const a = args[i];
        const b = args[i + 1];
        if (!isOrdEntity(a) || !isOrdEntity(b)) return numeric(...args); // mixed → numeric path's clear error
        if (!rel(a, b)) return schemeFalse;
      }
      return schemeTrue;
    }
    return numeric(...args);
  };
  // Preserve the speculation marker + operator name from the wrapped op so the evaluator's
  // speculative-eval path still engages (it forces HalfBaked args unless __speculate__ is set,
  // and keys early-collapse on op.name).
  (fn as { [SPECULATE]?: boolean })[SPECULATE] = (numeric as { [SPECULATE]?: boolean })[SPECULATE];
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

// The R7RS exception handler stack — a module-level holder (the dynamic-holder family,
// alongside the evaluator's _dynamicCallSite/_currentRunEnv). Replaces the old set!'d
// `*current-exception-handlers*` scheme cell: the R7RS exception forms push/pop it via the
// `%current-handlers`/`%set-handlers!` primitives below, so NO scheme `set!` remains.
// Process-global like the cell was (same dynamic visibility, so a deep `raise` sees it);
// per-run isolation lands later when the dynamic holders thread per-run through the trampoline.
let currentHandlers: unknown = nil;

// ── Loose (nil-tolerant) comparison overlay — CARVED from env/fl-interop.ts ──────────
// The base numeric comparisons throw on a nil operand (coerceNumeric rejects it). The
// inference plane wants nil-tolerance: a nil operand resolves to #f/nil-as-bottom rather
// than crashing a proof. `looseCompare` wraps each numeric/speculation core: a nil operand
// short-circuits to the loose universal order; otherwise the core runs (numbers + the
// HalfBaked speculative-decide + the non-number type-error). NOTE: the runCtx.strict gate is
// DROPPED in this carve (the bare operator entry is ctx-free) — loose is now unconditional.
const isNilOperand = (v) => v == null || (v)?.constructor?.name === "ANil";
const isNumberOperand = (v) => v instanceof AExact || v instanceof AInexact;
const flLteNum = (a, b) => a["arrival/tagless-final/lte"](b);
const LOOSE_NUM_PAIR = {
  "=": (a, b) => flLteNum(a, b) && flLteNum(b, a),
  "<": (a, b) => flLteNum(a, b) && !flLteNum(b, a),
  ">": (a, b) => flLteNum(b, a) && !flLteNum(a, b),
  "<=": (a, b) => flLteNum(a, b),
  ">=": (a, b) => flLteNum(b, a),
};
const ORD_FROM_LE = {
  "<": (ab, ba) => ab && !ba,
  ">": (ab, ba) => ba && !ab,
  "<=": (ab) => ab,
  ">=": (_ab, ba) => ba,
};
const describeLoose = (v) => (v instanceof AValue ? v.kind : v == null ? String(v) : typeof v);
function loosePairOrder(sym, a, b) {
  const nilCmp = nilOrderCompare(a, b);
  if (nilCmp !== undefined) return sym === "<" ? nilCmp < 0 : sym === ">" ? nilCmp > 0 : sym === "<=" ? nilCmp <= 0 : nilCmp >= 0;
  if (isNumberOperand(a) && isNumberOperand(b)) return LOOSE_NUM_PAIR[sym](a, b);
  if (!isOrd(a) || !isOrd(b)) throw new TypeError(`${sym}: cannot compare ${describeLoose(a)} and ${describeLoose(b)} — no shared order.`);
  const le_ab = Boolean((a)["arrival/tagless-final/lte"](b));
  const le_ba = Boolean((b)["arrival/tagless-final/lte"](a));
  if (!le_ab && !le_ba) throw new TypeError(`${sym}: cannot compare ${describeLoose(a)} and ${describeLoose(b)} — incompatible types.`);
  return ORD_FROM_LE[sym](le_ab, le_ba);
}
function looseOrderChain(sym, args) {
  let verdict = true;
  for (let i = 0; i < args.length - 1; i++) {
    if (!loosePairOrder(sym, args[i], args[i + 1])) { verdict = false; break; }
  }
  return withInputProvenance(args, verdict);
}
function looseCompare(sym, core) {
  const fn = function (...args) {
    // Run-level strict via the ambient holder (what bridge bare builtins read). For an
    // all-constant comparison like (= '() '()) there is no operand to carry strict — nil is a
    // global constant — so the run holder is the only honest source, exactly as car-of-nil reads it.
    if (isStrict()) {
      if (!args.every(isNumberOperand)) throw new TypeError(`${sym}: strict mode is R7RS-numeric — a non-number operand is rejected.`);
      return core(...args);
    }
    if (args.some(isNilOperand)) {
      if (sym === "=") return withInputProvenance(args, args.every(isNilOperand));
      return looseOrderChain(sym, args);
    }
    return core(...args);
  };
  if (SPECULATIVE_OPS.has(sym)) fn[SPECULATE] = true;
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

export const wrappedOps = {
  // ── The numeric core (arithmetic / comparison / predicates / conversions) has
  //    been carved into the `scheme/numeric` pack (env/r7rs/numeric.ts), bound via
  //    `symbol.native`. What remains here are the inline `ops.X.call`-based misc ops
  //    (floor//truncate//lcm/1+/1-/>>/<<), the makeTypePredicate tower predicates,
  //    the comparison overlay, the exactness conversions, and the R7RS exception
  //    machinery — each carved out in its own later phase. (See the carve phases.)
  "floor/"(n1: unknown, n2: unknown): unknown {
    const a = coerceNumeric(n1);
    const b = coerceNumeric(n2);
    const aExact = a instanceof AExact ? a : new AExact(a.ctx, BigInt(Math.trunc(a.real)));
    const bExact = b instanceof AExact ? b : new AExact(b.ctx, BigInt(Math.trunc(b.real)));
    const q = ops.floorQuotient.call([aExact, bExact]);
    const r = ops.floorRemainder.call([aExact, bExact]);
    const qNum = q instanceof AExact ? q : new AExact(a.ctx, q as unknown as bigint);
    const rNum = r instanceof AExact ? r : new AExact(a.ctx, r as unknown as bigint);
    return Values.from([qNum, rNum]);
  },

  "truncate/"(n1: unknown, n2: unknown): unknown {
    const a = coerceNumeric(n1);
    const b = coerceNumeric(n2);
    const aExact = a instanceof AExact ? a : new AExact(a.ctx, BigInt(Math.trunc(a.real)));
    const bExact = b instanceof AExact ? b : new AExact(b.ctx, BigInt(Math.trunc(b.real)));
    const q = ops.truncateQuotient.call([aExact, bExact]);
    const r = ops.truncateRemainder.call([aExact, bExact]);
    const qNum = q instanceof AExact ? q : new AExact(a.ctx, q as unknown as bigint);
    const rNum = r instanceof AExact ? r : new AExact(a.ctx, r as unknown as bigint);
    return Values.from([qNum, rNum]);
  },

  lcm(...args: unknown[]): ANumeric {
    if (args.length === 0) return new AExact(CONSTANT_CTX, 1n);
    let hasInexact = false;
    const exactArgs: AExact[] = [];
    for (const arg of args) {
      const n = coerceNumeric(arg);
      if (n instanceof AInexact) {
        hasInexact = true;
        exactArgs.push(new AExact(n.ctx, BigInt(Math.trunc(n.real))));
      } else {
        exactArgs.push(new AExact(n.ctx, n.num / n.denom));
      }
    }
    const result = ops.lcm.call(exactArgs);
    const resultBigint = result instanceof AExact ? result.num : (result as bigint);
    return hasInexact ? new AInexact(exactArgs[0].ctx, Number(resultBigint)) : new AExact(exactArgs[0].ctx, resultBigint);
  },

  "=": looseCompare("=", wrapOperator(ops.numEq)),
  "<": looseCompare("<", wrapOrd(wrapOperator(ops.lt), "<")),
  ">": looseCompare(">", wrapOrd(wrapOperator(ops.gt), ">")),
  "<=": looseCompare("<=", wrapOrd(wrapOperator(ops.lte), "<=")),
  ">=": looseCompare(">=", wrapOrd(wrapOperator(ops.gte), ">=")),

  // R7RS Type predicates
  "number?"(value: unknown): boolean {
    return isSchemeNumber(value);
  },

  // ============================================================================
  // LIPS-style aliases (for backwards compatibility with global_env)
  // ============================================================================

  "1+"(n: unknown): ANumeric {
    const converted = coerceNumeric(n);
    const one = new AExact(converted.ctx, 1n);
    return ops.add.call([converted, one]);
  },

  "1-"(n: unknown): ANumeric {
    const converted = coerceNumeric(n);
    const one = new AExact(converted.ctx, 1n);
    return ops.sub.call([converted, one]);
  },

  ">>"(a: unknown, b: unknown): ANumeric {
    const aNum = coerceNumeric(a);
    const bNum = coerceNumeric(b);
    return ops.arithmeticShift.call([aNum, bNum]);
  },

  "<<"(a: unknown, b: unknown): ANumeric {
    const aNum = coerceNumeric(a);
    const bNum = coerceNumeric(b);
    const negB = ops.sub.call([bNum]);
    return ops.arithmeticShift.call([aNum, negB]);
  },

  // R7RS exactness conversion
  inexact(z: unknown): AInexact {
    const n = coerceNumeric(z);
    if (n instanceof AInexact) return n;
    const exact = n;
    if (exact.denom === 1n) return new AInexact(exact.ctx, Number(exact.num));
    return new AInexact(exact.ctx, Number(exact.num) / Number(exact.denom));
  },

  exact(z: unknown): AExact {
    const n = coerceNumeric(z);
    if (n instanceof AExact) return n;
    const inexact = n;
    const real = inexact.real;
    TypeError.invariant(Number.isFinite(real), "Cannot convert infinity or NaN to exact");
    if (Number.isInteger(real)) return new AExact(inexact.ctx, BigInt(real));
    // JS Number.toString picks between fixed (`0.5`) and exponential (`1e-10`,
    // `1e+21`) notations based on magnitude. The fixed-notation path uses the
    // decimal-place count to derive the denominator. The exponential path was
    // unhandled — `indexOf(".") === -1` short-circuited to `BigInt(real)` and
    // threw RangeError on the non-integer float. Parse the mantissa+exponent
    // and combine into a single power-of-10 denominator.
    const str = real.toString();
    const expMatch = str.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
    if (expMatch) {
      const [, sign, intPart, fracPart = "", expStr] = expMatch;
      const exp = Number(expStr);
      // Combine: value = sign * (intPart.fracPart) * 10^exp
      //                = sign * (intPart fracPart) * 10^(exp - fracPart.length)
      const digits = intPart + fracPart;
      const netExp = exp - fracPart.length;
      const mantissa = BigInt(`${sign}${digits}`);
      const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
      if (netExp >= 0) {
        return new AExact(inexact.ctx, mantissa * 10n ** BigInt(netExp));
      }
      const denomBig = 10n ** BigInt(-netExp);
      const absNum = mantissa < 0n ? -mantissa : mantissa;
      const g = gcd(absNum, denomBig);
      return new AExact(inexact.ctx, mantissa / g, denomBig / g);
    }
    const decimalIndex = str.indexOf(".");
    if (decimalIndex === -1) return new AExact(inexact.ctx, BigInt(real));
    const decimals = str.length - decimalIndex - 1;
    const scale = 10n ** BigInt(decimals);
    const num = BigInt(Math.round(real * Number(scale)));
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
    const g = gcd(num < 0n ? -num : num, scale);
    return new AExact(inexact.ctx, num / g, scale / g);
  },

  // R5RS § 6.2.5 arrow-form aliases for the R7RS § 6.2 `exact`/`inexact` conversions
  // above. Relocated from stdlib.ts global_env (husk dissolution): they now sit next to
  // their targets and call them directly, so they ship in `numbersCapability` and bind
  // onto global_env in the same Phase-1 pass — no more call-time `global_env.get("exact")`
  // round-trip. The R7RS-renamed `exact`/`inexact` stay canonical; these are the
  // R5RS-compat spellings (chibi/gambit/racket) every Scheme that takes legacy code
  // seriously keeps.
  "exact->inexact"(z: unknown): AInexact {
    return wrappedOps.inexact(z);
  },

  "inexact->exact"(z: unknown): AExact {
    return wrappedOps.exact(z);
  },

  "number->string"(z: unknown, radix?: unknown): string {
    const n = coerceNumeric(z);
    const base = radix === undefined ? 10 : Number(coerceNumeric(radix).valueOf());
    if (n instanceof AExact) {
      if (n.denom === 1n) return n.num.toString(base);
      return `${n.num.toString(base)}/${n.denom.toString(base)}`;
    }
    const inexact = n;
    // Inexact mark preservation (R7RS § 6.2): `(number->string 5.0)` must NOT
    // return "5" — round-tripping through `string->number` would yield an
    // exact integer, violating the exactness contract. `SchemeInexact.toString()`
    // already appends `.0` to integers and emits the chibi-compatible
    // `+inf.0` / `+nan.0` markers. Delegate for base-10 (the only base R7RS
    // actually specifies for inexact formatting); for non-decimal bases the
    // JS Number formatter is the only realistic option.
    if (base === 10) {
      return inexact.toString();
    }
    return inexact.real.toString(base);
  },

  // ============================================================================
  // R7RS Exception Handling (Section 6.11)
  // ============================================================================

  "error-object?"(obj: unknown): boolean {
    return obj instanceof R7RSError;
  },

  "error-object-message"(err: unknown): string {
    // R7RS § 6.11: `error-object-message` is only defined over error objects
    // (values produced by the `error` procedure). The previous permissive
    // implementation returned `err.message` for any JS `Error` and stringified
    // anything else — meaning callers couldn't distinguish "real R7RS error"
    // from "some other thrown value happened to expose a message field."
    // Fail loudly instead.
    TypeError.invariant(err instanceof R7RSError, "error-object-message: argument is not an error object");
    return err.message;
  },

  "error-object-irritants"(err: unknown): unknown {
    if (err instanceof R7RSError) {
      // Convert JS array to Scheme list
      let result: unknown = nil;
      for (let i = err.irritants.length - 1; i >= 0; i--) {
        result = new APair(CONSTANT_CTX, err.irritants[i], result);
      }
      return result;
    }
    return nil;
  },

  "read-error?"(obj: unknown): boolean {
    return obj instanceof R7RSReadError;
  },

  "file-error?"(obj: unknown): boolean {
    return obj instanceof R7RSFileError;
  },

  "make-error-object"(message: unknown, ...irritants: unknown[]): R7RSError {
    const msg = message instanceof AString ? message.valueOf() : String(message);
    return new R7RSError(msg, ...irritants);
  },

  "raise-exception"(obj: unknown): never {
    throw new RaisedException(obj, false);
  },

  "raise-continuable-exception"(obj: unknown): never {
    throw new RaisedException(obj, true);
  },

  "raised-exception?"(obj: unknown): boolean {
    return obj instanceof RaisedException;
  },

  "raised-exception-value"(exc: unknown): unknown {
    if (exc instanceof RaisedException) {
      return exc.value;
    }
    return exc;
  },

  "raised-exception-continuable?"(exc: unknown): boolean {
    if (exc instanceof RaisedException) {
      return exc.continuable;
    }
    return false;
  },

  // Throw the object directly (not wrapped in Error with toString)
  // This preserves the original object type for R7RS exception handling
  "%raise"(obj: unknown): never {
    throw obj;
  },

  // Read / replace the handler stack (machinery; the R7RS forms push/pop through these
  // instead of mutating a scheme binding with `set!`).
  "%current-handlers"(): unknown {
    return currentHandlers;
  },

  "%set-handlers!"(handlers: unknown): unknown {
    currentHandlers = handlers;
    return nil;
  },
};

// ============================================================================
// Environment Integration
// ============================================================================

// The R7RS exception verbs in `wrappedOps`. Everything else in `wrappedOps` is the
// numeric core (the Operator/Profunctor↔Scheme bridge). The two are split into two
// capability packs below so they assemble like every other domain — no more imperative
// `applyToEnvironment` monolith. (Defined HERE, not in env/native-packs.ts, because the
// numeric machinery — wrapOperator / wrapOrd / speculativeCompare — lives in this module;
// importing it from a native-packs sibling would close the bridge↔native-packs cycle.)
const EXCEPTION_VERBS = new Set([
  "error-object?",
  "error-object-message",
  "error-object-irritants",
  "read-error?",
  "file-error?",
  "make-error-object",
  "raise-exception",
  "raise-continuable-exception",
  "raised-exception?",
  "raised-exception-value",
  "raised-exception-continuable?",
  "%raise",
  "%current-handlers",
  "%set-handlers!",
]);

const symbolsFrom = (entries: [string, unknown][]) => Object.fromEntries(entries.map(([k, v]) => [k, { value: v }]));

/** The numeric core (arithmetic, comparison, numeric predicates, conversions) as a pack. */
export const numbersCapability = new EnvCapability("scheme/numbers", {
  symbols: symbolsFrom(Object.entries(wrappedOps).filter(([k]) => !EXCEPTION_VERBS.has(k))),
});

/** The R7RS § 6.11 exception verbs as a pack. */
export const exceptionsCapability = new EnvCapability("scheme/exceptions", {
  symbols: symbolsFrom(Object.entries(wrappedOps).filter(([k]) => EXCEPTION_VERBS.has(k))),
});

/** The full native foundation assembled onto global_env: value-domain clusters + the
 *  bridge's own numbers + exceptions packs. */
const GLOBAL_NATIVE_PACKS = [...NATIVE_PACKS, numbersCapability, exceptionsCapability];

/**
 * Initialize bridge by applying all wrapped operators to the global LIPS environment
 * and evaluating the bootstrap Scheme code.
 */
let bootstrapPromise: Promise<void> | null = null;

export function initBridge(): Promise<void> {
  if (isBridgeInitialized() && bootstrapPromise) return bootstrapPromise;
  // Set the realm-level flag at the TOP, before the prelude eval below — so the
  // re-entrant inner exec (a pack prelude) sees `initialized === true` and skips
  // its own self-init (no recursion). See boot.ts.
  markBridgeInitialized();

  // The whole native foundation — value-domain clusters + numbers + exceptions — is
  // now assembled onto global_env as capability packs in the async chain below; the
  // imperative `applyToEnvironment(global_env)` monolith is gone. Async native
  // application is fine: every public `exec` awaits bootstrap COMPLETION (boot.ts
  // whenBootstrapComplete), not just the started-flag, so a racing exec never observes
  // a half-assembled env. (Bootstrap's own prelude evals use stdlib's gate-free `exec`,
  // so the completion await is never re-entrant.)

  // The scheme stdlib loads by ASSEMBLING the base packs onto user_env — not by
  // exec-ing one hand-concatenated `BOOTSTRAP_SCHEME` string. `assembleEnv` runs
  // each pack's full contribution (prelude + symbols + resolvers) in C3 order, so
  // the packs are the SOLE source of the scheme surface: e.g. polyglot's `@`/`:key`
  // and arrival's `symbol->string` now land here via their owning capability rather
  // than via separate hand-wiring. `evalScheme` injects the evaluator (exec into the
  // assembling env). The base preludes are verified mutually order-independent (none
  // expands another's macro), so the C3 application order is immaterial to them.
  // skipBootstrapWait: this exec IS the bootstrap (a base-pack prelude eval), so it
  // must NOT await bootstrap completion — that would deadlock on the very promise it
  // is part of.
  const evalScheme: EvalSchemeInto = (env, src) =>
    exec(src as string, { env: env as Environment, skipBootstrapWait: true });

  // Evaluate bootstrap Scheme code asynchronously, then expose a curated set of
  // bootstrap-defined bindings in the inference plane. They live in user_env; copy the
  // values into inferenceEnv so inference-plane/showcase code can reach them:
  //   • threading macros ->/->>/~>/~>>  — pure code-rewrites.
  //   • SRFI-26 cut/cute               — partial application; expand to a lambda.
  //   • gensym                          — cut/cute call it at expansion time for
  //                                       capture-safe slot names, so it has to be
  //                                       reachable from an inference-plane (cut …) site.
  // All pure: a macro's expansion still evaluates under the inference env, so
  // none adds a capability. (Dynamic import avoids a static bridge<->inference-env
  // import cycle.)
  //
  // NOT copied: the hygienic syntax family (define-syntax / let-syntax /
  // letrec-syntax + syntax-rules). They evaluate fine in the FULL env (the chibi
  // R7RS suite drives them), but the LIPS pattern matcher misbehaves under the
  // inference env — a `(double 50)` use of a inference-plane-defined syntax-rules macro
  // fails "no matching syntax in macro (50)". Env-specific matcher issue, tracked
  // separately; define-macro (an evaluator special form) is the working path for
  // user macros in the inference plane today.
  //   • SRFI-1 (the missing third) + safe head accessor first?/first-or — pure list
  //     procedures. first?/first-or make (car (filter …)) on an empty match — the
  //     dominant avoidable crash in generated Scheme — unnecessary. `remove` is now
  //     the SOLE source of `remove` in the inference plane (it used to shadow a broken Ramda
  //     `remove`; Ramda has since been removed entirely, so this copy is what supplies it).
  //   • Composition + quantifiers compose/comp/pipe/flow (polyglot) and some/every
  //     (SRFI-1). The inference plane (inferenceEnv) is the totalic env where models
  //     author Scheme; this composition/quantifier vocabulary used to reach it via the
  //     Ramda spread. Ramda has since been removed entirely, so copying the bootstrap
  //     definitions over is what keeps the plane's compose/pipe/some/every — sourced from
  //     pure Scheme. Pure, capability-free.
  // Assemble the native foundation (value-domain clusters + numbers + exceptions) onto
  // global_env FIRST (symbol-only, no prelude — `lower()` needs no evalScheme), THEN the
  // .scm base packs onto user_env. Order matters: a base-pack prelude may call a native
  // primitive (e.g. `string-length`, `+`), which resolves through user_env → global_env,
  // so the natives must already be live there.
  bootstrapPromise = assembleEnv(
    global_env as unknown as SchemeEnv,
    GLOBAL_NATIVE_PACKS.map((pack) => pack.lower()),
  )
    .then(() =>
      assembleEnv(
        userEnv as unknown as SchemeEnv,
        BASE_PACKS.map((pack) => pack.lower({ evalScheme })),
      ),
    )
    .then(async () => {
      // The FL/array-interop overlay (car/cdr/filter/map/reduce) is its own capability
      // pack. Assemble it onto the inference-plane base env HERE — after global_env's
      // native assembly and the base packs — so its lazily-captured `builtin*` refs
      // (read at first call from global_env) are guaranteed live. Doing it inside
      // whenBootstrapComplete's chain means a public exec never sees a half-assembled
      for (const name of [
        "->",
        "->>",
        "~>",
        "~>>",
        "cut",
        "cute",
        "gensym",
        "first?",
        "first-or",
        "iota",
        "delete-duplicates",
        "filter-map",
        "count",
        "list-index",
        "append-map",
        "remove",
        "compose",
        "comp",
        "pipe",
        "flow",
        "some",
        "every",
      ]) {
        const value = userEnv.get(name, { throwError: false });
        if (value) inferenceEnv.set(name, value);
      }
    });
  // Publish the COMPLETION promise so a public `exec` racing a fire-and-forget
  // `void initBridge()` (index.ts) awaits the full async assembly, not just the flag.
  setBootstrapComplete(bootstrapPromise);
  return bootstrapPromise;
}

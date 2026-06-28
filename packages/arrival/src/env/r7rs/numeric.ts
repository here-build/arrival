/**
 * Numeric core pack — the carved-out home of the R7RS numeric primitives.
 *
 * This is the dissolution of the legacy `Operator`/`Codec`/`wrappedOps` model
 * (membrane.ts + operators/numeric.ts + bridge.ts's `wrapOperator`). Each op is
 * bound via `symbol.native` under a LOOSE types-only contract — the impl IS the
 * binding, exactly as `wrappedOps` bound it (capability.ts `case "native"` →
 * `env.set(verb, def.impl)`), so the runtime behavior is byte-identical to
 * `wrapOperator(ops.X)`.
 *
 * `nativeNumericOp` reproduces `wrapOperator` (bridge.ts) ⊕ `Operator.call`
 * (membrane.ts) inline:
 *   1. provenance — union the AValue inputs; stamp the result (boxing a bare bool
 *      ONLY under non-empty provenance — the boolean landmine the
 *      boolean-landmine-regression test pins);
 *   2. coercion + error-naming — `coerceNumeric` each arg, naming the bad index;
 *   3. codec marshalling — per-arg `match`+`toJS` decode → `fn` → `out.fromJS`;
 *   4. Tier-2 speculation — the five comparison ops read a HalfBaked cardinality
 *      interval for early collapse; everything else forces it (the dispatch choke).
 *
 * The few codecs the numeric ops actually use (most are the identity `SchemeNum`)
 * are carved here too — membrane's `Codec` family is deleted in the teardown.
 */

import * as z from "../../common/scheme-zod.js";
import invariant from "tiny-invariant";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { SPECULATE } from "../../well-known-symbols.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { AValue, unionProvenance } from "../../values/primitives/AValue.js";
import { schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AHalfBaked, type Interval, is_half_baked } from "../../values/primitives/AHalfBaked.js";
import { type ANumeric, bigintISqrt, complexDoor, schemeCompare, toReal } from "../../values/numbers.js";
import { coerceNumeric, isSchemeNumber } from "../../values/op-helpers.js";
import { type } from "../../utils/typecheck.js";

// ════════════════════════════════════════════════════════════════════════════
// Codecs — carved from membrane.ts (the `Codec` family) + operators/numeric.ts
// (`SchemeNum`). After `coerceNumeric` every arg is already an ANumeric, so the
// dominant `SchemeNum` codec is the identity passthrough; a few convert to JS
// number/bigint for the ops whose `fn` works in JS-land (abs, the bitwise family,
// rounding, transcendentals).
// ════════════════════════════════════════════════════════════════════════════

interface NCodec<S, J> {
  match(value: unknown): value is S;
  toJS(value: S): J;
  fromJS(value: J): S;
}

/** Passthrough — keeps the ANumeric, no JS conversion (the dominant case). */
const SchemeNum: NCodec<ANumeric, ANumeric> = {
  match(v): v is ANumeric {
    return v instanceof AExact || v instanceof AInexact;
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

/** Any scheme number ↔ JS number/bigint. */
const AnyNum: NCodec<ANumeric, number | bigint> = {
  match(v): v is ANumeric {
    return v instanceof AExact || v instanceof AInexact;
  },
  toJS(v) {
    if (v instanceof AExact) {
      if (v.isInteger && v.num >= BigInt(Number.MIN_SAFE_INTEGER) && v.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(v.num);
      }
      if (v.isInteger) return v.num;
      return Number(v.num) / Number(v.denom);
    }
    return v.real;
  },
  fromJS(v) {
    if (typeof v === "bigint") {
      return new AExact(CONSTANT_CTX, v);
    }
    if (Number.isSafeInteger(v)) {
      return new AExact(CONSTANT_CTX, BigInt(v));
    }
    return new AInexact(CONSTANT_CTX, v);
  },
};

/** Exact integers ↔ JS bigint. */
const Int: NCodec<AExact, bigint> = {
  match(v): v is AExact {
    return v instanceof AExact && v.isInteger;
  },
  toJS: (v) => v.num,
  fromJS: (v) => new AExact(CONSTANT_CTX, v),
};

/** Safe integers ↔ JS number (for bitwise shift counts etc.). */
const SafeInt: NCodec<AExact, number> = {
  match(v): v is AExact {
    return (
      v instanceof AExact &&
      v.isInteger &&
      v.num >= BigInt(Number.MIN_SAFE_INTEGER) &&
      v.num <= BigInt(Number.MAX_SAFE_INTEGER)
    );
  },
  toJS: (v) => Number(v.num),
  fromJS: (v) => new AExact(CONSTANT_CTX, BigInt(v)),
};

/** Any number as JS number (lossy for bigints and rationals). */
const Num: NCodec<ANumeric, number> = {
  match(v): v is ANumeric {
    return v instanceof AExact || v instanceof AInexact;
  },
  toJS(v) {
    if (v instanceof AExact) {
      return Number(v.num) / Number(v.denom);
    }
    return v.real;
  },
  fromJS(v) {
    if (Number.isSafeInteger(v)) {
      return new AExact(CONSTANT_CTX, BigInt(v));
    }
    return new AInexact(CONSTANT_CTX, v);
  },
};

/** Scheme boolean ↔ JS boolean (identity — the box happens in the provenance stamp). */
const Bool: NCodec<boolean, boolean> = {
  match(v): v is boolean {
    return typeof v === "boolean";
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

// ════════════════════════════════════════════════════════════════════════════
// nativeNumericOp — `wrapOperator` (bridge.ts) ⊕ `Operator.call` (membrane.ts),
// reproduced byte-for-byte so the carve is behavior-preserving.
// ════════════════════════════════════════════════════════════════════════════

interface NumSpec {
  in: NCodec<any, any>[];
  inRest?: NCodec<any, any>;
  out: NCodec<any, any>;
  fn: (...jsArgs: any[]) => any;
}

/**
 * The raw `Operator.call` marshalling — arity guard + per-arg codec decode + the
 * `fn` + output encode, WITHOUT the provenance/coerce layer. `nativeNumericOp`
 * runs it after coercion; the inline misc ops (`floor/`, `>>`, …) that used to call
 * `ops.X.call(...)` directly run it too (those bypass the provenance layer, exactly
 * as `op.call` did).
 */
function marshalCall(name: string, spec: NumSpec, args: unknown[]): unknown {
  const { in: inCodecs, inRest, out, fn } = spec;
  const minArgs = inCodecs.length;
  TypeError.invariant(args.length >= minArgs, `${name}: expected at least ${minArgs} args, got ${args.length}`);
  TypeError.invariant(inRest || args.length <= minArgs, `${name}: expected ${minArgs} args, got ${args.length}`);
  const jsArgs = args.map((arg, i) => {
    const prof = i < inCodecs.length ? inCodecs[i] : inRest!;
    TypeError.invariant(prof.match(arg), `${name}: argument ${i} type mismatch`);
    return prof.toJS(arg as any);
  });
  const jsResult = fn(...(jsArgs as any));
  return out.fromJS(jsResult);
}

/**
 * Build the `(...args) => unknown` builtin for one numeric op — identical to
 * `wrapOperator(ops.X)`. See the file header for the four reproduced concerns.
 */
function nativeNumericOp(name: string, spec: NumSpec): (...args: unknown[]) => unknown {
  // The synchronous numeric core: provenance + coerce-with-naming + marshalled call.
  const applyNumeric = (callArgs: unknown[]): unknown => {
    const provenance = unionProvenance(callArgs.filter((a): a is AValue => a instanceof AValue));
    let converted: ANumeric[];
    try {
      converted = callArgs.map(coerceNumeric);
    } catch (cause) {
      // Name what actually failed — mirror isSchemeNumber's contract.
      const badIndex = callArgs.findIndex((a) => !isSchemeNumber(a));
      const typeNames = callArgs.map(type).join(", ");
      const detail = badIndex >= 0 ? `argument ${badIndex} is ${type(callArgs[badIndex])}` : "argument type mismatch";
      throw new TypeError(`Cannot apply ${name} to (${typeNames}): ${detail}`, { cause });
    }
    const result: unknown = marshalCall(name, spec, converted);
    if (provenance.size > 0) {
      if (result instanceof AValue) return result.withProvenance(provenance);
      // Box JS bool coming out of comparison/predicate operators. Empty-provenance
      // path returns raw bool to keep find/`!== false` callers alive (the landmine).
      if (typeof result === "boolean") {
        return (result ? schemeTrue : schemeFalse).withProvenance(provenance);
      }
    }
    return result;
  };

  const fn = function (...args: unknown[]): unknown {
    // Tier-2 speculative evaluation — a HalfBaked reaches here ONLY for the marked
    // comparison ops (the dispatch choke forces it for everything else). Decide early
    // against a narrowing interval, or force the carrier(s) and run the normal path.
    if (args.some(is_half_baked)) {
      const decided = SPECULATIVE_OPS.has(name) ? speculativeCompare(name, args) : undefined;
      if (decided !== undefined) return decided;
      return Promise.all(args.map((a) => (is_half_baked(a) ? a.force() : a))).then(applyNumeric);
    }
    return applyNumeric(args);
  };
  if (SPECULATIVE_OPS.has(name)) {
    (fn as { [SPECULATE]?: boolean })[SPECULATE] = true;
  }
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

// ════════════════════════════════════════════════════════════════════════════
// Tier-2 speculative comparison against a HalfBaked cardinality interval.
// Carved verbatim from bridge.ts. See
// docs/package-specific/arrival-scheme/speculative-evaluation-promise-functor-2026-06-05.md.
// ════════════════════════════════════════════════════════════════════════════

/** The comparison ops that can decide early against a narrowing interval. */
const SPECULATIVE_OPS = new Set(["=", "<", ">", "<=", ">="]);

/** `(op k hb)` ⟺ `(reflect[op] hb k)` — used to normalize the HalfBaked to the left. */
const REFLECT: Record<string, string> = { ">=": "<=", "<=": ">=", ">": "<", "<": ">", "=": "=" };

/**
 * The early-decision verdict for `(op interval k)`: returns a definite boolean the
 * instant the interval is decisive, or `undefined` to keep waiting. Sound by
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
 * `HalfBaked` (a narrowing cardinality interval) and the other is a concrete number.
 * Returns an early-decision `Promise<boolean>` (provenance-stamped to match the eager
 * path), or `undefined` when speculation doesn't apply.
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

// ════════════════════════════════════════════════════════════════════════════
// Operator implementations — carved VERBATIM from operators/numeric.ts. Each `fn`
// is the body that used to live inside `Operator.create(name, { …, fn })`.
// ════════════════════════════════════════════════════════════════════════════

// ── Arithmetic helpers (exactness-preserving) ───────────────────────────────────

function schemeAdd(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(a.ctx, aVal + bVal);
  }
  return (a as AExact).add(b as AExact);
}

function schemeSub(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(a.ctx, aVal - bVal);
  }
  return (a as AExact).sub(b as AExact);
}

function schemeNegate(a: ANumeric): ANumeric {
  if (a instanceof AInexact) {
    return new AInexact(a.ctx, -a.real);
  }
  return new AExact(a.ctx, -a.num, a.denom);
}

function schemeMul(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(a.ctx, aVal * bVal);
  }
  return (a as AExact).mul(b as AExact);
}

function schemeDiv(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(a.ctx, aVal / bVal);
  }
  return (a as AExact).div(b as AExact);
}

const addFn = (...args: ANumeric[]): ANumeric => {
  if (args.length === 0) return new AExact(CONSTANT_CTX, 0n);
  return args.reduce(schemeAdd);
};

const subFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  if (rest.length === 0) return schemeNegate(first);
  return rest.reduce(schemeSub, first);
};

const mulFn = (...args: ANumeric[]): ANumeric => {
  if (args.length === 0) return new AExact(CONSTANT_CTX, 1n);
  return args.reduce(schemeMul);
};

const divFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  if (rest.length === 0) {
    return schemeDiv(new AExact(first.ctx, 1n), first);
  }
  return rest.reduce(schemeDiv, first);
};

// ── Integer division family ─────────────────────────────────────────────────────

function toInteger(n: ANumeric, opName: string): { value: bigint | number; exact: boolean } {
  if (n instanceof AExact) {
    TypeError.invariant(n.denom === 1n, `${opName}: not an integer`);
    return { value: n.num, exact: true };
  } else {
    TypeError.invariant(Number.isInteger(n.real), `${opName}: not an integer`);
    return { value: n.real, exact: false };
  }
}

function toIntegerPair(
  a: ANumeric,
  b: ANumeric,
  opName: string,
): { bothExact: true; av: bigint; bv: bigint } | { bothExact: false; av: number; bv: number } {
  const ai = toInteger(a, opName);
  const bi = toInteger(b, opName);
  if (ai.exact && bi.exact) {
    return { bothExact: true, av: ai.value as bigint, bv: bi.value as bigint };
  }
  const av = ai.exact ? Number(ai.value) : (ai.value as number);
  const bv = bi.exact ? Number(bi.value) : (bi.value as number);
  return { bothExact: false, av, bv };
}

function bigintFloorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  if (a % b !== 0n && (a < 0n) !== (b < 0n)) {
    return q - 1n;
  }
  return q;
}

const quotientFn = (a: bigint, b: bigint): bigint => {
  invariant(b != 0n, "quotient: division by zero");
  return a / b;
};

const remainderFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "remainder");
  if (p.bothExact) {
    invariant(p.bv !== 0n, "remainder: division by zero");
    return new AExact(a.ctx, p.av % p.bv);
  }
  return new AInexact(a.ctx, p.av % p.bv);
};

const moduloFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "modulo");
  if (p.bothExact) {
    invariant(p.bv !== 0n, "modulo: division by zero");
    return new AExact(a.ctx, ((p.av % p.bv) + p.bv) % p.bv);
  }
  return new AInexact(a.ctx, ((p.av % p.bv) + p.bv) % p.bv);
};

const floorQuotientFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "floor-quotient");
  if (p.bothExact) {
    invariant(p.bv !== 0n, "floor-quotient: division by zero");
    return new AExact(a.ctx, bigintFloorDiv(p.av, p.bv));
  }
  return new AInexact(a.ctx, Math.floor(p.av / p.bv));
};

const floorRemainderFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "floor-remainder");
  if (p.bothExact) {
    invariant(p.bv !== 0n, "floor-remainder: division by zero");
    return new AExact(a.ctx, ((p.av % p.bv) + p.bv) % p.bv);
  }
  const q = Math.floor(p.av / p.bv);
  return new AInexact(a.ctx, p.av - q * p.bv);
};

const truncateQuotientFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "truncate-quotient");
  if (p.bothExact) {
    invariant(p.bv !== 0n, "truncate-quotient: division by zero");
    return new AExact(a.ctx, p.av / p.bv);
  }
  return new AInexact(a.ctx, Math.trunc(p.av / p.bv));
};

const truncateRemainderFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "truncate-remainder");
  if (p.bothExact) {
    invariant(p.bv !== 0n, "truncate-remainder: division by zero");
    return new AExact(a.ctx, p.av % p.bv);
  }
  return new AInexact(a.ctx, p.av % p.bv);
};

const absFn = (x: number | bigint): number | bigint =>
  typeof x === "bigint" ? (x < 0n ? -x : x) : Math.abs(x);

// ── gcd / lcm ───────────────────────────────────────────────────────────────────

function gcd2(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

const gcdFn = (...args: bigint[]): bigint => {
  if (args.length === 0) return 0n;
  return args.reduce(gcd2, 0n);
};

// ── expt ─────────────────────────────────────────────────────────────────────────

function schemeExpt(base: ANumeric, power: ANumeric): ANumeric {
  if (base instanceof AExact && power instanceof AExact && power.denom === 1n) {
    const n = power.num;
    if (n >= 0n) {
      return new AExact(base.ctx, base.num ** n, base.denom ** n);
    }
    invariant(base.num !== 0n, "expt: division by zero (0 raised to a negative power)");
    const m = -n;
    return new AExact(base.ctx, base.denom ** m, base.num ** m);
  }
  return new AInexact(base.ctx, Math.pow(toReal(base), toReal(power)));
}

// ── Comparison cores ─────────────────────────────────────────────────────────────

function schemeNumEq(a: ANumeric, b: ANumeric): boolean {
  if (a instanceof AExact && b instanceof AExact) {
    return a.cmp(b) === 0;
  }
  if (a instanceof AInexact && b instanceof AInexact) {
    return a.real === b.real;
  }
  const aReal = a instanceof AExact ? Number(a.num) / Number(a.denom) : a.real;
  const bReal = b instanceof AExact ? Number(b.num) / Number(b.denom) : b.real;
  return aReal === bReal;
}

const numEqFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  return rest.every((x) => schemeNumEq(first, x));
};

// ── max / min ────────────────────────────────────────────────────────────────────

const maxFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  let extreme = first;
  let hasInexact = first instanceof AInexact;
  for (const x of rest) {
    if (x instanceof AInexact) hasInexact = true;
    if (schemeCompare(x, extreme) > 0) extreme = x;
  }
  return hasInexact && extreme instanceof AExact ? extreme.toInexact() : extreme;
};

const minFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  let extreme = first;
  let hasInexact = first instanceof AInexact;
  for (const x of rest) {
    if (x instanceof AInexact) hasInexact = true;
    if (schemeCompare(x, extreme) < 0) extreme = x;
  }
  return hasInexact && extreme instanceof AExact ? extreme.toInexact() : extreme;
};

// ── Predicates ────────────────────────────────────────────────────────────────────

const isZeroFn = (x: number | bigint): boolean => x === 0 || x === 0n;
const isPositiveFn = (x: number | bigint): boolean => (typeof x === "bigint" ? x > 0n : x > 0);
const isNegativeFn = (x: number | bigint): boolean => (typeof x === "bigint" ? x < 0n : x < 0);
const isOddFn = (x: bigint): boolean => x % 2n !== 0n;
const isEvenFn = (x: bigint): boolean => x % 2n === 0n;

// ── Rounding ──────────────────────────────────────────────────────────────────────

const roundFn = (x: number): number => {
  // R7RS: round to even on ties (banker's rounding).
  const floored = Math.floor(x);
  const ceiled = Math.ceil(x);
  const diff = x - floored;
  if (diff < 0.5) return floored;
  if (diff > 0.5) return ceiled;
  if (floored % 2 === 0) return floored;
  return ceiled;
};

// ── Rational accessors ──────────────────────────────────────────────────────────────

function floatToRational(x: number): { num: bigint; denom: bigint } {
  invariant(Number.isFinite(x), "numerator/denominator requires a finite number");
  if (Number.isInteger(x)) {
    return { num: BigInt(x), denom: 1n };
  }
  const str = x.toString();
  const dotIndex = str.indexOf(".");
  if (dotIndex === -1) {
    return { num: BigInt(x), denom: 1n };
  }
  const decimals = str.length - dotIndex - 1;
  const denom = 10n ** BigInt(decimals);
  const num = BigInt(str.replace(".", "").replace(/^-/, ""));
  const sign = x < 0 ? -1n : 1n;
  const g = gcd2(num < 0n ? -num : num, denom);
  return { num: (sign * num) / g, denom: denom / g };
}

const numeratorFn = (x: ANumeric): ANumeric => {
  if (x instanceof AExact) {
    return new AExact(x.ctx, x.num);
  }
  invariant(x instanceof AInexact, "numerator requires a rational number");
  const { num } = floatToRational(x.real);
  return new AInexact(x.ctx, Number(num));
};

const denominatorFn = (x: ANumeric): ANumeric => {
  if (x instanceof AExact) {
    return new AExact(x.ctx, x.denom);
  }
  invariant(x instanceof AInexact, "denominator requires a rational number");
  const { denom } = floatToRational(x.real);
  return new AInexact(x.ctx, Number(denom));
};

// ── Transcendentals ─────────────────────────────────────────────────────────────────

const sqrtFn = (x: ANumeric): ANumeric => {
  const val = x instanceof AExact ? x.valueOf() : x.real;
  if (val < 0) {
    complexDoor();
  }
  if (x instanceof AExact && x.denom === 1n && x.num >= 0n) {
    const r = bigintISqrt(x.num);
    if (r * r === x.num) {
      return new AExact(x.ctx, r);
    }
  }
  return new AInexact(x.ctx, Math.sqrt(val));
};

const logFn = (z: number, base?: number): number => (base === undefined ? Math.log(z) : Math.log(z) / Math.log(base));
const atanFn = (y: number, x?: number): number => (x === undefined ? Math.atan(y) : Math.atan2(y, x));

// ── Bitwise ────────────────────────────────────────────────────────────────────────

const bitwiseAndFn = (...args: bigint[]): bigint => {
  if (args.length === 0) return -1n;
  return args.reduce((a, b) => a & b);
};

const bitwiseIorFn = (...args: bigint[]): bigint => {
  if (args.length === 0) return 0n;
  return args.reduce((a, b) => a | b);
};

const bitwiseXorFn = (...args: bigint[]): bigint => {
  if (args.length === 0) return 0n;
  return args.reduce((a, b) => a ^ b);
};

const bitwiseNotFn = (x: bigint): bigint => ~x;

const arithmeticShiftFn = (n: bigint, count: number): bigint => (count >= 0 ? n << BigInt(count) : n >> BigInt(-count));

// ════════════════════════════════════════════════════════════════════════════
// Reused op specs / cores — the aliases (`**`/`%`/`==`/`|`/`&`/`~`) bind the SAME
// op object as their canonical sibling (byte-identical to the original, which
// minted a fresh `wrapOperator(ops.X)` carrying the canonical op's name).
// `arithmeticShiftSpec` is also consumed by the `>>`/`<<` inline ops (Phase 4).
// ════════════════════════════════════════════════════════════════════════════

const arithmeticShiftSpec: NumSpec = { in: [Int, SafeInt], out: Int, fn: arithmeticShiftFn };

const exptOp = nativeNumericOp("expt", { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: schemeExpt });
const remainderOp = nativeNumericOp("remainder", { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: remainderFn });
const numEqOp = nativeNumericOp("=", { in: [SchemeNum], inRest: SchemeNum, out: Bool, fn: numEqFn });
const bitwiseIorOp = nativeNumericOp("bitwise-ior", { in: [], inRest: Int, out: Int, fn: bitwiseIorFn });
const bitwiseAndOp = nativeNumericOp("bitwise-and", { in: [], inRest: Int, out: Int, fn: bitwiseAndFn });
const bitwiseNotOp = nativeNumericOp("bitwise-not", { in: [Int], out: Int, fn: bitwiseNotFn });

// ════════════════════════════════════════════════════════════════════════════
// The pack. Each op is bound via `symbol.native` under a LOOSE types-only
// contract — no per-op zod authoring; the impl IS the binding.
// ════════════════════════════════════════════════════════════════════════════

/** Bind a carved numeric op under the loose, types-only native contract. The impl
 *  works on scheme values directly (no codec/validation at the symbol layer — the
 *  marshalling lives inside the impl), exactly as `wrappedOps` bound it. */
const bind = (nameDoc: string, impl: (...args: unknown[]) => unknown) =>
  symbol.native([nameDoc] as unknown as TemplateStringsArray)(
    { input: z.array(z.unknown()), output: [z.unknown()] },
    impl,
  );

export default new EnvCapability("scheme/numeric", {
  symbols: {
    // ── Arithmetic ──────────────────────────────────────────────────────────────
    "+": bind("+: variadic sum (0 with no args)", nativeNumericOp("+", { in: [], inRest: SchemeNum, out: SchemeNum, fn: addFn })),
    "-": bind("-: difference; unary negates", nativeNumericOp("-", { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: subFn })),
    "*": bind("*: variadic product (1 with no args)", nativeNumericOp("*", { in: [], inRest: SchemeNum, out: SchemeNum, fn: mulFn })),
    "/": bind("/: division; unary is reciprocal", nativeNumericOp("/", { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: divFn })),
    quotient: bind("quotient: integer quotient truncated toward zero", nativeNumericOp("quotient", { in: [Int, Int], out: Int, fn: quotientFn })),
    remainder: bind("remainder: remainder of truncating division", remainderOp),
    modulo: bind("modulo: modulo (sign of divisor)", nativeNumericOp("modulo", { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: moduloFn })),
    "floor-quotient": bind("floor-quotient: quotient toward negative infinity", nativeNumericOp("floor-quotient", { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: floorQuotientFn })),
    "floor-remainder": bind("floor-remainder: remainder of floor division", nativeNumericOp("floor-remainder", { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: floorRemainderFn })),
    "truncate-quotient": bind("truncate-quotient: quotient truncated toward zero", nativeNumericOp("truncate-quotient", { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: truncateQuotientFn })),
    "truncate-remainder": bind("truncate-remainder: remainder of truncating division", nativeNumericOp("truncate-remainder", { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: truncateRemainderFn })),
    numerator: bind("numerator: numerator of a rational", nativeNumericOp("numerator", { in: [SchemeNum], out: SchemeNum, fn: numeratorFn })),
    denominator: bind("denominator: denominator of a rational", nativeNumericOp("denominator", { in: [SchemeNum], out: SchemeNum, fn: denominatorFn })),
    "make-rectangular": bind("make-rectangular: DOORED (complex unsupported)", nativeNumericOp("make-rectangular", { in: [Num, Num], out: SchemeNum, fn: (): ANumeric => complexDoor() })),
    "make-polar": bind("make-polar: DOORED (complex unsupported)", nativeNumericOp("make-polar", { in: [Num, Num], out: SchemeNum, fn: (): ANumeric => complexDoor() })),
    "real-part": bind("real-part: DOORED (complex unsupported)", nativeNumericOp("real-part", { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() })),
    "imag-part": bind("imag-part: DOORED (complex unsupported)", nativeNumericOp("imag-part", { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() })),
    magnitude: bind("magnitude: DOORED (complex unsupported)", nativeNumericOp("magnitude", { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() })),
    angle: bind("angle: DOORED (complex unsupported)", nativeNumericOp("angle", { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() })),
    abs: bind("abs: absolute value", nativeNumericOp("abs", { in: [AnyNum], out: AnyNum, fn: absFn })),
    gcd: bind("gcd: greatest common divisor (non-negative)", nativeNumericOp("gcd", { in: [], inRest: Int, out: Int, fn: gcdFn })),
    expt: bind("expt: exponentiation", exptOp),
    max: bind("max: maximum (inexactness contagious)", nativeNumericOp("max", { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: maxFn })),
    min: bind("min: minimum (inexactness contagious)", nativeNumericOp("min", { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: minFn })),

    // ── Sign / parity predicates (throwing — coerce then test) ───────────────────
    "zero?": bind("zero?: #t iff n is zero", nativeNumericOp("zero?", { in: [AnyNum], out: Bool, fn: isZeroFn })),
    "positive?": bind("positive?: #t iff n > 0", nativeNumericOp("positive?", { in: [AnyNum], out: Bool, fn: isPositiveFn })),
    "negative?": bind("negative?: #t iff n < 0", nativeNumericOp("negative?", { in: [AnyNum], out: Bool, fn: isNegativeFn })),
    "odd?": bind("odd?: #t iff n is odd", nativeNumericOp("odd?", { in: [Int], out: Bool, fn: isOddFn })),
    "even?": bind("even?: #t iff n is even", nativeNumericOp("even?", { in: [Int], out: Bool, fn: isEvenFn })),

    // ── Rounding ─────────────────────────────────────────────────────────────────
    floor: bind("floor: largest integer ≤ n", nativeNumericOp("floor", { in: [Num], out: Num, fn: Math.floor })),
    ceiling: bind("ceiling: smallest integer ≥ n", nativeNumericOp("ceiling", { in: [Num], out: Num, fn: Math.ceil })),
    truncate: bind("truncate: integer toward zero", nativeNumericOp("truncate", { in: [Num], out: Num, fn: Math.trunc })),
    round: bind("round: nearest integer, ties to even", nativeNumericOp("round", { in: [Num], out: Num, fn: roundFn })),

    // ── Transcendentals ──────────────────────────────────────────────────────────
    sqrt: bind("sqrt: square root (exact for perfect squares)", nativeNumericOp("sqrt", { in: [SchemeNum], out: SchemeNum, fn: sqrtFn })),
    exp: bind("exp: e raised to n", nativeNumericOp("exp", { in: [Num], out: Num, fn: Math.exp })),
    log: bind("log: natural log, or log base", nativeNumericOp("log", { in: [Num], inRest: Num, out: Num, fn: logFn })),
    sin: bind("sin: sine (radians)", nativeNumericOp("sin", { in: [Num], out: Num, fn: Math.sin })),
    cos: bind("cos: cosine (radians)", nativeNumericOp("cos", { in: [Num], out: Num, fn: Math.cos })),
    tan: bind("tan: tangent (radians)", nativeNumericOp("tan", { in: [Num], out: Num, fn: Math.tan })),
    asin: bind("asin: arc sine", nativeNumericOp("asin", { in: [Num], out: Num, fn: Math.asin })),
    acos: bind("acos: arc cosine", nativeNumericOp("acos", { in: [Num], out: Num, fn: Math.acos })),
    atan: bind("atan: arc tangent, or atan2", nativeNumericOp("atan", { in: [Num], inRest: Num, out: Num, fn: atanFn })),

    // ── Bitwise (integer only) ────────────────────────────────────────────────────
    "bitwise-and": bind("bitwise-and: bitwise AND", bitwiseAndOp),
    "bitwise-ior": bind("bitwise-ior: bitwise inclusive OR", bitwiseIorOp),
    "bitwise-xor": bind("bitwise-xor: bitwise exclusive OR", nativeNumericOp("bitwise-xor", { in: [], inRest: Int, out: Int, fn: bitwiseXorFn })),
    "bitwise-not": bind("bitwise-not: bitwise NOT", bitwiseNotOp),
    "arithmetic-shift": bind("arithmetic-shift: shift left (right if count < 0)", nativeNumericOp("arithmetic-shift", arithmeticShiftSpec)),

    // ── LIPS-style aliases (canonical-named cores under the alias key) ────────────
    "**": bind("**: exponentiation (alias of expt)", exptOp),
    "%": bind("%: remainder (alias)", remainderOp),
    "==": bind("==: numeric equality (alias of =)", numEqOp),
    "|": bind("|: bitwise inclusive OR (alias)", bitwiseIorOp),
    "&": bind("&: bitwise AND (alias)", bitwiseAndOp),
    "~": bind("~: bitwise NOT (alias)", bitwiseNotOp),
  },
});

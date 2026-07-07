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
// `TypeError.invariant` (used below, e.g. `marshalCall`) is a global augmentation —
// import it explicitly so this file's correctness doesn't depend on some OTHER module
// in the load graph happening to import it first.
import "@here.build/error-invariant";
import { symbol, type Contract, type RestSpec, type VectorSpec } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { SPECULATE } from "../../well-known-symbols.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { CallCtx } from "../../common/symbols/_bake.js";
import { AValue, unionProvenance } from "../../values/primitives/AValue.js";
import { schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AHalfBaked, type Interval, is_half_baked } from "../../values/primitives/AHalfBaked.js";
import { Values } from "../../values/primitives/Values.js";
import { type ANumeric, bigintISqrt, complexDoor, schemeCompare, toReal } from "../../values/numbers.js";
import {
  coerceNumeric,
  isSchemeNumber,
  isOrd,
  ORD_REL,
  nilOrderCompare,
  withInputProvenance,
  type AOrd,
} from "../../values/op-helpers.js";
import { type } from "../../utils/typecheck.js";
import { tf } from "../../values/tagless-final.js";

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
    // `prof.match` IS a real type predicate (`(value: unknown) => value is S`), and
    // `TypeError.invariant` is a TS assertion function (`asserts condition`) — the same
    // narrowing machinery `if (prof.match(arg))` would give. So this assertion narrows
    // `arg: unknown` down to `prof`'s own `S` with no cast: the old `arg as any` was
    // already inert, just unproven at the call site. `S` resolves to `any` here because
    // `prof` is picked dynamically per-index out of a heterogeneous codec list (`in`/
    // `inRest` can each carry a DIFFERENT NCodec's S/J) — that heterogeneity is inherent
    // to a shared dispatch table keyed by op name, not a typing gap.
    TypeError.invariant(prof.match(arg), `${name}: argument ${i} type mismatch`);
    return prof.toJS(arg);
  });
  // `jsArgs` is already `any[]` (each `prof.toJS(arg)` above returns `J = any`, same
  // per-index-heterogeneity reason) — `fn` (`(...jsArgs: any[]) => any`) accepts it directly.
  const jsResult = fn(...jsArgs);
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
    } catch (error) {
      // Name what actually failed — mirror isSchemeNumber's contract.
      const badIndex = callArgs.findIndex((a) => !isSchemeNumber(a));
      const typeNames = callArgs.map(type).join(", ");
      const detail = badIndex === -1 ? "argument type mismatch" : `argument ${badIndex} is ${type(callArgs[badIndex])}`;
      throw new TypeError(`Cannot apply ${name} to (${typeNames}): ${detail}`, { cause: error });
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

/**
 * The R7RS tower-type predicates (`complex?`/`real?`/`rational?`/`integer?`/`exact?`/
 * …/`nan?`) — carved from bridge.ts's `makeTypePredicate`. A DIFFERENT shape from
 * `nativeNumericOp`: total over the value domain (a non-number returns #f, never an
 * error) and NO provenance box (raw JS bool, exactly as `makeTypePredicate` returned).
 */
function nativeTypePredicate(name: string, predicate: (n: ANumeric) => boolean): (...args: unknown[]) => unknown {
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
  if (a % b !== 0n && a < 0n !== b < 0n) {
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

const absFn = (x: number | bigint): number | bigint => (typeof x === "bigint" ? (x < 0n ? -x : x) : Math.abs(x));

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

const ltFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    if (!(schemeCompare(prev, x) < 0)) return false;
    prev = x;
  }
  return true;
};

const gtFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    if (!(schemeCompare(prev, x) > 0)) return false;
    prev = x;
  }
  return true;
};

const lteFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    // NaN ⇒ schemeCompare returns NaN ⇒ `NaN <= 0` is false ⇒ short-circuit.
    if (!(schemeCompare(prev, x) <= 0)) return false;
    prev = x;
  }
  return true;
};

const gteFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    if (!(schemeCompare(prev, x) >= 0)) return false;
    prev = x;
  }
  return true;
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
// minted a fresh `wrapOperator(ops.X)` carrying the canonical op's name). Specs are
// named (not just the built op) so an alias's `symbol.native` declaration below can
// build the SAME Contract shape its canonical sibling declares (`contractFromSpec(spec)`)
// while still passing the identical shared impl reference. `arithmeticShiftSpec` is
// also consumed by the `>>`/`<<`
// inline ops (Phase 4).
// ════════════════════════════════════════════════════════════════════════════

const arithmeticShiftSpec: NumSpec = { in: [Int, SafeInt], out: Int, fn: arithmeticShiftFn };

const exptSpec: NumSpec = { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: schemeExpt };
const remainderSpec: NumSpec = { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: remainderFn };
const numEqSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: Bool, fn: numEqFn };
const bitwiseIorSpec: NumSpec = { in: [], inRest: Int, out: Int, fn: bitwiseIorFn };
const bitwiseAndSpec: NumSpec = { in: [], inRest: Int, out: Int, fn: bitwiseAndFn };
const bitwiseNotSpec: NumSpec = { in: [Int], out: Int, fn: bitwiseNotFn };

const exptOp = nativeNumericOp("expt", exptSpec);
const remainderOp = nativeNumericOp("remainder", remainderSpec);
const numEqOp = nativeNumericOp("=", numEqSpec);
const bitwiseIorOp = nativeNumericOp("bitwise-ior", bitwiseIorSpec);
const bitwiseAndOp = nativeNumericOp("bitwise-and", bitwiseAndSpec);
const bitwiseNotOp = nativeNumericOp("bitwise-not", bitwiseNotSpec);

// The numeric comparison cores (provenance + speculation), wrapped by `wrapOrd`
// (FL-Ord fallback) and `looseCompare` (nil-tolerant overlay) below.
const ltSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: Bool, fn: ltFn };
const gtSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: Bool, fn: gtFn };
const lteSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: Bool, fn: lteFn };
const gteSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: Bool, fn: gteFn };

const ltOp = nativeNumericOp("<", ltSpec);
const gtOp = nativeNumericOp(">", gtSpec);
const lteOp = nativeNumericOp("<=", lteSpec);
const gteOp = nativeNumericOp(">=", gteSpec);

// ════════════════════════════════════════════════════════════════════════════
// Comparison overlay — carved VERBATIM from bridge.ts. `wrapOrd` adds the FL-Ord
// fallback (non-numeric ordered entities: strings/chars/DateTime/…); `looseCompare`
// adds the nil-tolerant inference-plane overlay + the strict-mode gate. Numbers fall
// through to the numeric/speculative core.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wrap a NUMERIC operator with the FL-Ord fallback. FL-Ord only intercepts
 * NON-NUMERIC ordered entities; a number falls through to `numeric(...)` (ORD_REL is a
 * TOTAL-order shortcut that is WRONG for the partial numeric order, and the numeric op
 * carries provenance + the speculative early-collapse the FL branch can't).
 */
function wrapOrd(numeric: (...a: unknown[]) => unknown, sym: "<" | ">" | "<=" | ">="): (...a: unknown[]) => unknown {
  const rel = ORD_REL[sym];
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
  // Preserve the speculation marker + name so the evaluator's speculative-eval path engages.
  (fn as { [SPECULATE]?: boolean })[SPECULATE] = (numeric as { [SPECULATE]?: boolean })[SPECULATE];
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

// ── Loose (nil-tolerant) comparison overlay ──────────────────────────────────────
// The base comparisons throw on a nil operand (coerceNumeric rejects it). The
// inference plane wants nil-tolerance: a nil operand resolves to #f/nil-as-bottom.
// Under strict mode (RunContext.strict, read off the reconstructed `this.ctx.runCtx`) loose
// is gated off — an all-constant comparison like `(= '() '())` carries no operand to thread
// strict, so the run ctx (not the operands) is the only honest source.
const isNilOperand = (v) => v == null || v?.constructor?.name === "ANil";
const isNumberOperand = (v) => v instanceof AExact || v instanceof AInexact;
const flLteNum = (a, b) => a[tf("lte")](b);
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
  if (nilCmp !== undefined)
    return sym === "<" ? nilCmp < 0 : sym === ">" ? nilCmp > 0 : sym === "<=" ? nilCmp <= 0 : nilCmp >= 0;
  if (isNumberOperand(a) && isNumberOperand(b)) return LOOSE_NUM_PAIR[sym](a, b);
  if (!isOrd(a) || !isOrd(b))
    throw new TypeError(`${sym}: cannot compare ${describeLoose(a)} and ${describeLoose(b)} — no shared order.`);
  const le_ab = Boolean(a[tf("lte")](b));
  const le_ba = Boolean(b[tf("lte")](a));
  if (!le_ab && !le_ba)
    throw new TypeError(`${sym}: cannot compare ${describeLoose(a)} and ${describeLoose(b)} — incompatible types.`);
  return ORD_FROM_LE[sym](le_ab, le_ba);
}
function looseOrderChain(sym, args) {
  let verdict = true;
  for (let i = 0; i < args.length - 1; i++) {
    if (!loosePairOrder(sym, args[i], args[i + 1])) {
      verdict = false;
      break;
    }
  }
  return withInputProvenance(args, verdict);
}
function looseCompare(sym, core) {
  // strict is run-CONSTANT but can't ride the operands — an all-constant compare
  // (`(= '() '())`) carries only CONSTANT_CTX operands. It rides the run's ctx, reconstructed
  // onto `this.runCtx` by the native-value adapter (capability.ts) at every invocation
  // path (call-head bare-fn, applyCallback fallback, ANativeProcedure impl). Replaces the
  // retired ambient `isStrict()` holder.
  const fn = function (this: CallCtx, ...args) {
    if (this.runCtx.strict === true) {
      if (!args.every(isNumberOperand))
        throw new TypeError(`${sym}: strict mode is R7RS-numeric — a non-number operand is rejected.`);
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

// ════════════════════════════════════════════════════════════════════════════
// Inline misc ops — carved VERBATIM from bridge.ts's `wrappedOps` methods. These
// did their own coercion and called `ops.X.call(...)` directly (the marshalling
// layer, bypassing the provenance layer), so they map to the carved fns / a
// `marshalCall` against the carved spec — never `nativeNumericOp`.
// ════════════════════════════════════════════════════════════════════════════

const lcmCoreFn = (...args: bigint[]): bigint => {
  if (args.length === 0) return 1n;
  const lcm2 = (a: bigint, b: bigint): bigint => {
    const g = gcd2(a, b);
    return g === 0n ? 0n : (a / g) * b;
  };
  // Seed with 1n and abs each operand so the result is non-negative.
  return args.reduce((a, b) => lcm2(a, b < 0n ? -b : b), 1n);
};
const lcmSpec: NumSpec = { in: [], inRest: Int, out: Int, fn: lcmCoreFn };

const floorSlashFn = (n1: unknown, n2: unknown): unknown => {
  const a = coerceNumeric(n1);
  const b = coerceNumeric(n2);
  const aExact = a instanceof AExact ? a : new AExact(a.ctx, BigInt(Math.trunc(a.real)));
  const bExact = b instanceof AExact ? b : new AExact(b.ctx, BigInt(Math.trunc(b.real)));
  // Both operands are AExact, so floorQuotient/floorRemainder take the bothExact
  // branch and return AExact — no reconstruction (the old `as unknown as bigint`
  // would have fed a non-bigint to the ctor's denom!=0n invariant in a dead else).
  const q = floorQuotientFn(aExact, bExact);
  const r = floorRemainderFn(aExact, bExact);
  return Values.from([q, r]);
};

const truncateSlashFn = (n1: unknown, n2: unknown): unknown => {
  const a = coerceNumeric(n1);
  const b = coerceNumeric(n2);
  const aExact = a instanceof AExact ? a : new AExact(a.ctx, BigInt(Math.trunc(a.real)));
  const bExact = b instanceof AExact ? b : new AExact(b.ctx, BigInt(Math.trunc(b.real)));
  // Both operands are AExact, so truncateQuotient/truncateRemainder take the
  // bothExact branch and return AExact — no reconstruction (the old
  // `as unknown as bigint` would have fed a non-bigint to the ctor in a dead else).
  const q = truncateQuotientFn(aExact, bExact);
  const r = truncateRemainderFn(aExact, bExact);
  return Values.from([q, r]);
};

const lcmFn = (...args: unknown[]): ANumeric => {
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
  const result = marshalCall("lcm", lcmSpec, exactArgs);
  const resultBigint = result instanceof AExact ? result.num : (result as bigint);
  return hasInexact ? new AInexact(exactArgs[0].ctx, Number(resultBigint)) : new AExact(exactArgs[0].ctx, resultBigint);
};

const onePlusFn = (n: unknown): ANumeric => {
  const converted = coerceNumeric(n);
  const one = new AExact(converted.ctx, 1n);
  return addFn(converted, one);
};

const oneMinusFn = (n: unknown): ANumeric => {
  const converted = coerceNumeric(n);
  const one = new AExact(converted.ctx, 1n);
  return subFn(converted, one);
};

const shiftRightFn = (a: unknown, b: unknown): ANumeric => {
  const aNum = coerceNumeric(a);
  const bNum = coerceNumeric(b);
  return marshalCall("arithmetic-shift", arithmeticShiftSpec, [aNum, bNum]) as ANumeric;
};

const shiftLeftFn = (a: unknown, b: unknown): ANumeric => {
  const aNum = coerceNumeric(a);
  const bNum = coerceNumeric(b);
  const negB = subFn(bNum);
  return marshalCall("arithmetic-shift", arithmeticShiftSpec, [aNum, negB]) as ANumeric;
};

const inexactFn = (z: unknown): AInexact => {
  const n = coerceNumeric(z);
  if (n instanceof AInexact) return n;
  const exact = n;
  if (exact.denom === 1n) return new AInexact(exact.ctx, Number(exact.num));
  return new AInexact(exact.ctx, Number(exact.num) / Number(exact.denom));
};

const exactFn = (z: unknown): AExact => {
  const n = coerceNumeric(z);
  if (n instanceof AExact) return n;
  const inexact = n;
  const real = inexact.real;
  TypeError.invariant(Number.isFinite(real), "Cannot convert infinity or NaN to exact");
  if (Number.isInteger(real)) return new AExact(inexact.ctx, BigInt(real));
  // JS Number.toString picks fixed (`0.5`) vs exponential (`1e-10`/`1e+21`) by
  // magnitude. Parse the mantissa+exponent and combine into a power-of-10 denom.
  const str = real.toString();
  const expMatch = str.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
  if (expMatch) {
    const [, sign, intPart, fracPart = "", expStr] = expMatch;
    const exp = Number(expStr);
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
};

const numberToStringFn = (z: unknown, radix?: unknown): string => {
  const n = coerceNumeric(z);
  const base = radix === undefined ? 10 : Number(coerceNumeric(radix).valueOf());
  if (n instanceof AExact) {
    if (n.denom === 1n) return n.num.toString(base);
    return `${n.num.toString(base)}/${n.denom.toString(base)}`;
  }
  const inexact = n;
  // Inexact mark preservation (R7RS § 6.2): `(number->string 5.0)` must stay "5.0".
  if (base === 10) {
    return inexact.toString();
  }
  return inexact.real.toString(base);
};

// ════════════════════════════════════════════════════════════════════════════
// Codec → zod-schema bridge. Each of the six `NCodec` instances above has a
// zod-schema counterpart whose DECODED (`z.output`) type matches that codec's own
// `toJS`/`fromJS` JS-side type exactly — mapping through this table turns a NumSpec
// into a real `symbol.native` Contract. PURE TYPE-LAYER: `symbol.native` never runs
// this validation at runtime — `def.in`/`def.out` feed static inference and the
// future `.d.ts` harvest only; `nativeNumericOp`'s OWN `marshalCall` remains the sole
// runtime type-check/coerce/dispatch. The pairing, verified against each codec's own
// `match`/`toJS`/`fromJS` (not just its name):
//
//   SchemeNum → z.schemeNumber   identity (ANumeric↔ANumeric) — exact match.
//   AnyNum    → z.numberOrBigint no existing schema decoded to `number | bigint`
//               (z.number/z.integer are number-only, z.bigint is bigint-only);
//               ported verbatim from AnyNum's own toJS/fromJS.
//   Int       → z.bigint        decoded type (bigint) matches Int.toJS's return exactly;
//               z.bigint's INPUT side also accepts AInexact (Int.match doesn't) — inert
//               for a native contract, which is never decoded/validated at runtime.
//   SafeInt   → z.integer       exact match (both are "safe-integer, as a JS number").
//   Num       → z.number        decoded type (number) matches Num.toJS's return exactly;
//               z.integer would be WRONG (Num's domain includes non-integers like 3.7 —
//               e.g. floor's input — z.integer's decode would door on those). z.number's
//               decode FUNCTION BODY doors on a non-integer exact rational / out-of-range
//               exact integer where Num.toJS instead lossily divides — again inert, since
//               a native contract's decode is never invoked at runtime.
//   Bool      → z.boolean       decoded type (boolean) matches Bool.toJS's return exactly;
//               z.boolean's INPUT side is `z.instanceof(ABool)` (a boxed scheme bool)
//               where Bool.match is a raw JS `typeof v === "boolean"` (marshalCall runs
//               BEFORE nativeNumericOp's provenance wrapper boxes to ABool/schemeTrue/
//               schemeFalse) — again inert for the same reason.
// ════════════════════════════════════════════════════════════════════════════

const CODEC_SCHEMA = new Map<NCodec<any, any>, z.ZodTypeAny>([
  [SchemeNum, z.schemeNumber],
  [AnyNum, z.numberOrBigint],
  [Int, z.bigint],
  [SafeInt, z.integer],
  [Num, z.number],
  [Bool, z.boolean],
]);

/** The zod schema a NumSpec codec maps to (see the table above). Throws if a NEW NCodec
 *  is ever added to the pack without a matching CODEC_SCHEMA entry — a loud authoring
 *  error, not a silent `z.value` regression. */
function codecSchema(codec: NCodec<any, any>): z.ZodTypeAny {
  const schema = CODEC_SCHEMA.get(codec);
  invariant(schema, "numeric.ts: no zod schema mapped for this NCodec (add it to CODEC_SCHEMA)");
  return schema;
}

/** Map a NumSpec's own precise codec types to a real `symbol.native` Contract —
 *  1-tuple output (the common case). `floor/`/`truncate/`'s 2-value output and the
 *  bespoke (non-NumSpec) ops below build their Contract by hand instead. */
function contractFromSpec(spec: NumSpec): Contract<VectorSpec, VectorSpec, RestSpec> {
  return {
    input: spec.in.map(codecSchema),
    inputRest: spec.inRest === undefined ? undefined : codecSchema(spec.inRest),
    output: [codecSchema(spec.out)],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Per-op specs — named so a `symbols` entry below builds its Contract
// (`contractFromSpec(spec)`) AND its impl (`nativeNumericOp(name, spec)`) from ONE
// shared object, instead of writing the same in/inRest/out shape twice. Every
// `symbols` entry below is a LITERAL `symbol.native` call — no bindOp/bind wrapper
// hiding it (the old bake* constructors these once reached into `_bake.ts` for are
// dissolved; see that file's note on where they went).
// ════════════════════════════════════════════════════════════════════════════

const addSpec: NumSpec = { in: [], inRest: SchemeNum, out: SchemeNum, fn: addFn };
const subSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: subFn };
const mulSpec: NumSpec = { in: [], inRest: SchemeNum, out: SchemeNum, fn: mulFn };
const divSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: divFn };
const quotientSpec: NumSpec = { in: [Int, Int], out: Int, fn: quotientFn };
const moduloSpec: NumSpec = { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: moduloFn };
const floorQuotientSpec: NumSpec = { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: floorQuotientFn };
const floorRemainderSpec: NumSpec = { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: floorRemainderFn };
const truncateQuotientSpec: NumSpec = { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: truncateQuotientFn };
const truncateRemainderSpec: NumSpec = { in: [SchemeNum, SchemeNum], out: SchemeNum, fn: truncateRemainderFn };
const numeratorSpec: NumSpec = { in: [SchemeNum], out: SchemeNum, fn: numeratorFn };
const denominatorSpec: NumSpec = { in: [SchemeNum], out: SchemeNum, fn: denominatorFn };
const makeRectangularSpec: NumSpec = { in: [Num, Num], out: SchemeNum, fn: (): ANumeric => complexDoor() };
const makePolarSpec: NumSpec = { in: [Num, Num], out: SchemeNum, fn: (): ANumeric => complexDoor() };
const realPartSpec: NumSpec = { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() };
const imagPartSpec: NumSpec = { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() };
const magnitudeSpec: NumSpec = { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() };
const angleSpec: NumSpec = { in: [SchemeNum], out: SchemeNum, fn: (): ANumeric => complexDoor() };
const absSpec: NumSpec = { in: [AnyNum], out: AnyNum, fn: absFn };
const gcdSpec: NumSpec = { in: [], inRest: Int, out: Int, fn: gcdFn };
const maxSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: maxFn };
const minSpec: NumSpec = { in: [SchemeNum], inRest: SchemeNum, out: SchemeNum, fn: minFn };
const zeroSpec: NumSpec = { in: [AnyNum], out: Bool, fn: isZeroFn };
const positiveSpec: NumSpec = { in: [AnyNum], out: Bool, fn: isPositiveFn };
const negativeSpec: NumSpec = { in: [AnyNum], out: Bool, fn: isNegativeFn };
const oddSpec: NumSpec = { in: [Int], out: Bool, fn: isOddFn };
const evenSpec: NumSpec = { in: [Int], out: Bool, fn: isEvenFn };
const floorSpec: NumSpec = { in: [Num], out: Num, fn: Math.floor };
const ceilingSpec: NumSpec = { in: [Num], out: Num, fn: Math.ceil };
const truncateSpec: NumSpec = { in: [Num], out: Num, fn: Math.trunc };
const roundSpec: NumSpec = { in: [Num], out: Num, fn: roundFn };
const sqrtSpec: NumSpec = { in: [SchemeNum], out: SchemeNum, fn: sqrtFn };
const expSpec: NumSpec = { in: [Num], out: Num, fn: Math.exp };
const logSpec: NumSpec = { in: [Num], inRest: Num, out: Num, fn: logFn };
const sinSpec: NumSpec = { in: [Num], out: Num, fn: Math.sin };
const cosSpec: NumSpec = { in: [Num], out: Num, fn: Math.cos };
const tanSpec: NumSpec = { in: [Num], out: Num, fn: Math.tan };
const asinSpec: NumSpec = { in: [Num], out: Num, fn: Math.asin };
const acosSpec: NumSpec = { in: [Num], out: Num, fn: Math.acos };
const atanSpec: NumSpec = { in: [Num], inRest: Num, out: Num, fn: atanFn };
const bitwiseXorSpec: NumSpec = { in: [], inRest: Int, out: Int, fn: bitwiseXorFn };

// ── Bespoke contracts — ops whose impl does NOT come from `nativeNumericOp`/`NumSpec`
// (its own coercion + a bespoke wrapper around `marshalCall`, or no NumSpec at all), so
// their Contract is hand-declared to match the impl's OWN already-`unknown`-typed JS
// signature (input) and its narrowest declared return type (output) — never a `NumSpec`
// borrowed from an unrelated internal helper. (E.g. `lcmFn` wraps `lcmSpec`'s raw
// bigint-in/bigint-out `marshalCall` with its OWN pre/post ANumeric coercion —
// `lcmSpec` describes that INTERNAL step, not `lcmFn`'s real `(...unknown[]) =>
// ANumeric` signature, so it is not reused here.) ──────────────────────────────────

/** `complex?`/`real?`/`rational?`/`integer?`/`exact?`/`inexact?`/`exact-integer?`/
 *  `finite?`/`infinite?`/`nan?`/`number?` — all `(value: unknown) => boolean`, TOTAL
 *  over the value domain (never throws, a non-number is simply `#f`). Representation-
 *  blind input (matches `lists.ts`'s own convention for "genuinely could be anything"). */
const PREDICATE_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = { input: [z.value], output: [z.boolean] };

/** `floor/`/`truncate/` — `(n1: unknown, n2: unknown) => Values` of TWO scheme numbers.
 *  Input tightened from `z.value` to `z.schemeNumber`: both impls' first act is
 *  `coerceNumeric` on each operand (op-helpers.ts) — the contract states the SCHEME-LEVEL
 *  domain (a scheme exact/inexact value), matching every sibling `NumSpec`-driven contract
 *  above (`contractFromSpec` maps `SchemeNum` → `z.schemeNumber` the same way); the wider
 *  JS-side coercion `coerceNumeric` also accepts (raw bigint/number, a valueOf()-able
 *  object) is an internal leniency, not a documented caller contract. */
const TWO_VALUE_OUTPUT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber, z.schemeNumber],
  output: [z.schemeNumber, z.schemeNumber],
};

/** `1+`/`1-` — `(n: unknown) => ANumeric`. See `TWO_VALUE_OUTPUT_CONTRACT` above for why
 *  the input is `z.schemeNumber`, not `z.value` (`onePlusFn`/`oneMinusFn` both
 *  `coerceNumeric` their argument first). */
const ONE_ARG_NUM_OUTPUT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.schemeNumber],
};

/** `>>`/`<<` — `(a: unknown, b: unknown) => ANumeric`. Same reasoning as
 *  `TWO_VALUE_OUTPUT_CONTRACT`: `shiftRightFn`/`shiftLeftFn` `coerceNumeric` both operands
 *  before handing them to `marshalCall(arithmeticShiftSpec, …)`, which itself doors at
 *  runtime if either isn't integer-shaped — the WIDE `schemeNumber` here is the honest
 *  declared domain; the integer narrowing is `arithmeticShiftSpec`'s own runtime check. */
const TWO_ARG_NUM_OUTPUT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber, z.schemeNumber],
  output: [z.schemeNumber],
};

/** `lcm` — `(...args: unknown[]) => ANumeric`. `lcmFn` `coerceNumeric`s every arg before
 *  its own exact/inexact bookkeeping — same reasoning as the contracts above. */
const LCM_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: z.array(z.schemeNumber),
  output: [z.schemeNumber],
};

/** `inexact`/`exact->inexact` — `(z: unknown) => AInexact`: narrower than the generic
 *  scheme-number union, matching `inexactFn`'s own declared return type exactly. Input is
 *  `z.schemeNumber` (`inexactFn` `coerceNumeric`s its argument first — same reasoning as
 *  `TWO_VALUE_OUTPUT_CONTRACT` above). */
const INEXACT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.inexact],
};

/** `exact`/`inexact->exact` — `(z: unknown) => AExact`: narrower than the generic
 *  scheme-number union, matching `exactFn`'s own declared return type exactly. Input is
 *  `z.schemeNumber` (`exactFn` `coerceNumeric`s its argument first — same reasoning as
 *  `TWO_VALUE_OUTPUT_CONTRACT` above). */
const EXACT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.exact],
};

/** `number->string` — `(z: unknown, radix?: unknown) => string` (a RAW JS string, not a
 *  boxed AString — matches `z.string`'s DECODED type exactly; see the codec-bridge note
 *  on `Bool`/`z.boolean` above for why the codec's boxed INPUT side is inert here too).
 *  Both `z`/`radix` are `z.schemeNumber` — `numberToStringFn` `coerceNumeric`s each. */
const NUMBER_TO_STRING_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber, z.schemeNumber.optional()],
  output: [z.string],
};

export default new EnvCapability("scheme/numeric", {
  symbols: {
    // ── Arithmetic ──────────────────────────────────────────────────────────────
    "+": symbol.native`+: variadic sum (0 with no args)`(contractFromSpec(addSpec), nativeNumericOp("+", addSpec)),
    "-": symbol.native`-: difference; unary negates`(contractFromSpec(subSpec), nativeNumericOp("-", subSpec)),
    "*": symbol.native`*: variadic product (1 with no args)`(contractFromSpec(mulSpec), nativeNumericOp("*", mulSpec)),
    "/": symbol.native`/: division; unary is reciprocal`(contractFromSpec(divSpec), nativeNumericOp("/", divSpec)),
    quotient: symbol.native`quotient: integer quotient truncated toward zero`(
      contractFromSpec(quotientSpec),
      nativeNumericOp("quotient", quotientSpec),
    ),
    remainder: symbol.native`remainder: remainder of truncating division`(contractFromSpec(remainderSpec), remainderOp),
    modulo: symbol.native`modulo: modulo (sign of divisor)`(
      contractFromSpec(moduloSpec),
      nativeNumericOp("modulo", moduloSpec),
    ),
    "floor-quotient": symbol.native`floor-quotient: quotient toward negative infinity`(
      contractFromSpec(floorQuotientSpec),
      nativeNumericOp("floor-quotient", floorQuotientSpec),
    ),
    "floor-remainder": symbol.native`floor-remainder: remainder of floor division`(
      contractFromSpec(floorRemainderSpec),
      nativeNumericOp("floor-remainder", floorRemainderSpec),
    ),
    "truncate-quotient": symbol.native`truncate-quotient: quotient truncated toward zero`(
      contractFromSpec(truncateQuotientSpec),
      nativeNumericOp("truncate-quotient", truncateQuotientSpec),
    ),
    "truncate-remainder": symbol.native`truncate-remainder: remainder of truncating division`(
      contractFromSpec(truncateRemainderSpec),
      nativeNumericOp("truncate-remainder", truncateRemainderSpec),
    ),
    numerator: symbol.native`numerator: numerator of a rational`(
      contractFromSpec(numeratorSpec),
      nativeNumericOp("numerator", numeratorSpec),
    ),
    denominator: symbol.native`denominator: denominator of a rational`(
      contractFromSpec(denominatorSpec),
      nativeNumericOp("denominator", denominatorSpec),
    ),
    "make-rectangular": symbol.native`make-rectangular: DOORED (complex unsupported)`(
      contractFromSpec(makeRectangularSpec),
      nativeNumericOp("make-rectangular", makeRectangularSpec),
    ),
    "make-polar": symbol.native`make-polar: DOORED (complex unsupported)`(
      contractFromSpec(makePolarSpec),
      nativeNumericOp("make-polar", makePolarSpec),
    ),
    "real-part": symbol.native`real-part: DOORED (complex unsupported)`(
      contractFromSpec(realPartSpec),
      nativeNumericOp("real-part", realPartSpec),
    ),
    "imag-part": symbol.native`imag-part: DOORED (complex unsupported)`(
      contractFromSpec(imagPartSpec),
      nativeNumericOp("imag-part", imagPartSpec),
    ),
    magnitude: symbol.native`magnitude: DOORED (complex unsupported)`(
      contractFromSpec(magnitudeSpec),
      nativeNumericOp("magnitude", magnitudeSpec),
    ),
    angle: symbol.native`angle: DOORED (complex unsupported)`(
      contractFromSpec(angleSpec),
      nativeNumericOp("angle", angleSpec),
    ),
    abs: symbol.native`abs: absolute value`(contractFromSpec(absSpec), nativeNumericOp("abs", absSpec)),
    gcd: symbol.native`gcd: greatest common divisor (non-negative)`(
      contractFromSpec(gcdSpec),
      nativeNumericOp("gcd", gcdSpec),
    ),
    expt: symbol.native`expt: exponentiation`(contractFromSpec(exptSpec), exptOp),
    max: symbol.native`max: maximum (inexactness contagious)`(
      contractFromSpec(maxSpec),
      nativeNumericOp("max", maxSpec),
    ),
    min: symbol.native`min: minimum (inexactness contagious)`(
      contractFromSpec(minSpec),
      nativeNumericOp("min", minSpec),
    ),

    // ── Comparison (numeric core + FL-Ord fallback + nil-tolerant overlay) ────────
    "=": symbol.native`=: numeric equality (nil-tolerant)`(contractFromSpec(numEqSpec), looseCompare("=", numEqOp)),
    "<": symbol.native`<: strictly increasing (FL-Ord fallback, nil-tolerant)`(
      contractFromSpec(ltSpec),
      looseCompare("<", wrapOrd(ltOp, "<")),
    ),
    ">": symbol.native`>: strictly decreasing`(contractFromSpec(gtSpec), looseCompare(">", wrapOrd(gtOp, ">"))),
    "<=": symbol.native`<=: non-decreasing`(contractFromSpec(lteSpec), looseCompare("<=", wrapOrd(lteOp, "<="))),
    ">=": symbol.native`>=: non-increasing`(contractFromSpec(gteSpec), looseCompare(">=", wrapOrd(gteOp, ">="))),

    // ── Sign / parity predicates (throwing — coerce then test) ───────────────────
    "zero?": symbol.native`zero?: #t iff n is zero`(contractFromSpec(zeroSpec), nativeNumericOp("zero?", zeroSpec)),
    "positive?": symbol.native`positive?: #t iff n > 0`(
      contractFromSpec(positiveSpec),
      nativeNumericOp("positive?", positiveSpec),
    ),
    "negative?": symbol.native`negative?: #t iff n < 0`(
      contractFromSpec(negativeSpec),
      nativeNumericOp("negative?", negativeSpec),
    ),
    "odd?": symbol.native`odd?: #t iff n is odd`(contractFromSpec(oddSpec), nativeNumericOp("odd?", oddSpec)),
    "even?": symbol.native`even?: #t iff n is even`(contractFromSpec(evenSpec), nativeNumericOp("even?", evenSpec)),

    // ── R7RS tower-type predicates (total — a non-number is #f, not an error) ─────
    "complex?": symbol.native`complex?: #t for any number`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("complex?", (n) => n.isComplex),
    ),
    "real?": symbol.native`real?: #t for any number (reals-only tower)`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("real?", (n) => n.isReal),
    ),
    "rational?": symbol.native`rational?: #t for finite reals`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("rational?", (n) => n.isRational),
    ),
    "integer?": symbol.native`integer?: #t for integer values (exact or inexact)`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("integer?", (n) => n.isInteger),
    ),
    "exact?": symbol.native`exact?: #t for exact numbers`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("exact?", (n) => n.isExact),
    ),
    "inexact?": symbol.native`inexact?: #t for inexact numbers`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("inexact?", (n) => !n.isExact),
    ),
    "exact-integer?": symbol.native`exact-integer?: #t for exact integers`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("exact-integer?", (n) => n.isExact && n.isInteger),
    ),
    "finite?": symbol.native`finite?: #t for finite numbers`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("finite?", (n) => n.isFinite),
    ),
    "infinite?": symbol.native`infinite?: #t for ±infinity`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("infinite?", (n) => !n.isFinite && !n.isNaN),
    ),
    "nan?": symbol.native`nan?: #t for NaN`(
      PREDICATE_CONTRACT,
      nativeTypePredicate("nan?", (n) => n.isNaN),
    ),

    // ── Rounding ─────────────────────────────────────────────────────────────────
    floor: symbol.native`floor: largest integer ≤ n`(contractFromSpec(floorSpec), nativeNumericOp("floor", floorSpec)),
    ceiling: symbol.native`ceiling: smallest integer ≥ n`(
      contractFromSpec(ceilingSpec),
      nativeNumericOp("ceiling", ceilingSpec),
    ),
    truncate: symbol.native`truncate: integer toward zero`(
      contractFromSpec(truncateSpec),
      nativeNumericOp("truncate", truncateSpec),
    ),
    round: symbol.native`round: nearest integer, ties to even`(
      contractFromSpec(roundSpec),
      nativeNumericOp("round", roundSpec),
    ),

    // ── Transcendentals ──────────────────────────────────────────────────────────
    sqrt: symbol.native`sqrt: square root (exact for perfect squares)`(
      contractFromSpec(sqrtSpec),
      nativeNumericOp("sqrt", sqrtSpec),
    ),
    exp: symbol.native`exp: e raised to n`(contractFromSpec(expSpec), nativeNumericOp("exp", expSpec)),
    log: symbol.native`log: natural log, or log base`(contractFromSpec(logSpec), nativeNumericOp("log", logSpec)),
    sin: symbol.native`sin: sine (radians)`(contractFromSpec(sinSpec), nativeNumericOp("sin", sinSpec)),
    cos: symbol.native`cos: cosine (radians)`(contractFromSpec(cosSpec), nativeNumericOp("cos", cosSpec)),
    tan: symbol.native`tan: tangent (radians)`(contractFromSpec(tanSpec), nativeNumericOp("tan", tanSpec)),
    asin: symbol.native`asin: arc sine`(contractFromSpec(asinSpec), nativeNumericOp("asin", asinSpec)),
    acos: symbol.native`acos: arc cosine`(contractFromSpec(acosSpec), nativeNumericOp("acos", acosSpec)),
    atan: symbol.native`atan: arc tangent, or atan2`(contractFromSpec(atanSpec), nativeNumericOp("atan", atanSpec)),

    // ── Bitwise (integer only) ────────────────────────────────────────────────────
    "bitwise-and": symbol.native`bitwise-and: bitwise AND`(contractFromSpec(bitwiseAndSpec), bitwiseAndOp),
    "bitwise-ior": symbol.native`bitwise-ior: bitwise inclusive OR`(contractFromSpec(bitwiseIorSpec), bitwiseIorOp),
    "bitwise-xor": symbol.native`bitwise-xor: bitwise exclusive OR`(
      contractFromSpec(bitwiseXorSpec),
      nativeNumericOp("bitwise-xor", bitwiseXorSpec),
    ),
    "bitwise-not": symbol.native`bitwise-not: bitwise NOT`(contractFromSpec(bitwiseNotSpec), bitwiseNotOp),
    "arithmetic-shift": symbol.native`arithmetic-shift: shift left (right if count < 0)`(
      contractFromSpec(arithmeticShiftSpec),
      nativeNumericOp("arithmetic-shift", arithmeticShiftSpec),
    ),

    // ── LIPS-style aliases (canonical-named cores under the alias key) ────────────
    "**": symbol.native`**: exponentiation (alias of expt)`(contractFromSpec(exptSpec), exptOp),
    "%": symbol.native`%: remainder (alias)`(contractFromSpec(remainderSpec), remainderOp),
    "==": symbol.native`==: numeric equality (alias of =)`(contractFromSpec(numEqSpec), numEqOp),
    "|": symbol.native`|: bitwise inclusive OR (alias)`(contractFromSpec(bitwiseIorSpec), bitwiseIorOp),
    "&": symbol.native`&: bitwise AND (alias)`(contractFromSpec(bitwiseAndSpec), bitwiseAndOp),
    "~": symbol.native`~: bitwise NOT (alias)`(contractFromSpec(bitwiseNotSpec), bitwiseNotOp),

    // ── Inline misc ops (own coercion + marshalled call; no provenance layer) ─────
    // Each impl below has a CONCRETE fixed-arity signature (unlike nativeNumericOp/
    // nativeTypePredicate's erased `(...args: unknown[]) => unknown`), so it doesn't
    // satisfy the (deliberately loose) `Contract<VectorSpec,VectorSpec,RestSpec>` these
    // hand-declared contracts carry without erasing the arity first — same boundary
    // rosetta.ts/sequence.ts's `run` cross, cast once per declaration, right here.
    "floor/": symbol.native`floor/: floor quotient and remainder (two values)`(
      TWO_VALUE_OUTPUT_CONTRACT,
      floorSlashFn as (...args: unknown[]) => unknown,
    ),
    "truncate/": symbol.native`truncate/: truncate quotient and remainder (two values)`(
      TWO_VALUE_OUTPUT_CONTRACT,
      truncateSlashFn as (...args: unknown[]) => unknown,
    ),
    lcm: symbol.native`lcm: least common multiple (non-negative)`(LCM_CONTRACT, lcmFn),
    "number?": symbol.native`number?: #t for any number`(PREDICATE_CONTRACT, ((value: unknown) =>
      isSchemeNumber(value)) as (...args: unknown[]) => unknown),
    "1+": symbol.native`1+: increment by one`(
      ONE_ARG_NUM_OUTPUT_CONTRACT,
      onePlusFn as (...args: unknown[]) => unknown,
    ),
    "1-": symbol.native`1-: decrement by one`(
      ONE_ARG_NUM_OUTPUT_CONTRACT,
      oneMinusFn as (...args: unknown[]) => unknown,
    ),
    ">>": symbol.native`>>: arithmetic-shift by the count`(
      TWO_ARG_NUM_OUTPUT_CONTRACT,
      shiftRightFn as (...args: unknown[]) => unknown,
    ),
    "<<": symbol.native`<<: arithmetic-shift by the negated count`(
      TWO_ARG_NUM_OUTPUT_CONTRACT,
      shiftLeftFn as (...args: unknown[]) => unknown,
    ),
    inexact: symbol.native`inexact: exact→inexact conversion`(
      INEXACT_CONTRACT,
      inexactFn as (...args: unknown[]) => unknown,
    ),
    exact: symbol.native`exact: inexact→exact conversion`(EXACT_CONTRACT, exactFn as (...args: unknown[]) => unknown),
    "exact->inexact": symbol.native`exact->inexact: R5RS spelling of inexact`(
      INEXACT_CONTRACT,
      inexactFn as (...args: unknown[]) => unknown,
    ),
    "inexact->exact": symbol.native`inexact->exact: R5RS spelling of exact`(
      EXACT_CONTRACT,
      exactFn as (...args: unknown[]) => unknown,
    ),
    "number->string": symbol.native`number->string: format a number in a radix`(
      NUMBER_TO_STRING_CONTRACT,
      numberToStringFn as (...args: unknown[]) => unknown,
    ),
  },
});

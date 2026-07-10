/**
 * R7RS numeric core — each op bound via `symbol.native` (LOOSE types-only
 * contract; the impl IS the binding, capability.ts `case "native"`).
 *
 * `nativeNumericOp` — pack's per-op wrapper, three concerns inline:
 *   1. provenance — union AValue inputs, stamp result; boolean verdicts via R8
 *      mint (`mintVerdict`: flyweight when provenance-free, fresh ABool otherwise);
 *   2. coercion + error-naming — `coerceNumeric` each arg, naming the bad index;
 *   3. codec marshalling — per-arg decode → `fn` → `out.fromJS`.
 *
 * `NumSpec.in`/`inRest`/`out` are real `z.ZodTypeAny` schemas from scheme-zod.ts —
 * ONE vocabulary, consumed by both `marshalCall` (runtime) and `contractFromSpec`
 * (type-inference face). `marshalCall`'s doc below carries the two identity
 * special-cases (`z.schemeNumber`, `z.boolean`) this surfaces.
 *
 * Comparison ops resolve directly through the numeric core — no Tier-2 HalfBaked
 * speculative evaluation branch exists for them.
 */

import * as z from "../../common/scheme-zod.js";
import invariant from "tiny-invariant";
// `TypeError.invariant` is a global augmentation — import explicitly so correctness
// doesn't depend on load order.
import "@here.build/error-invariant";
import { symbol, type Contract, type RestSpec, type VectorSpec } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { CallCtx } from "../../common/symbols/_bake.js";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "../../values/primitives/AValue.js";
import type { ABool } from "../../values/primitives/ABool.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AString } from "../../values/primitives/AString.js";
import { Values } from "../../values/primitives/Values.js";
import { type ANumeric, bigintISqrt, complexDoor, schemeCompare, toReal } from "../../values/numbers.js";
import {
  coerceNumeric,
  isSchemeNumber,
  isOrd,
  ORD_REL,
  nilOrderCompare,
  mintVerdict,
  isEagerAccumulationActive,
  type AOrd,
} from "../../values/op-helpers.js";
import { type } from "../../utils/typecheck.js";
import { tf } from "../../values/tagless-final.js";

// ════════════════════════════════════════════════════════════════════════════
// nativeNumericOp — pack's per-op wrapper (R8 mintVerdict, A4 always-box).
// ════════════════════════════════════════════════════════════════════════════

interface NumSpec {
  in: z.ZodTypeAny[];
  inRest?: z.ZodTypeAny;
  out: z.ZodTypeAny;
  fn: (...jsArgs: any[]) => any;
}

/**
 * Per-arg DECODE (scheme → JS) via the schema's own `.safeParse` (uniform-vocabulary
 * ruling — the schema IS the NCodec `match`+`toJS` fusion). Two runtime realities:
 *  1. `.safeParse` does NOT catch a raw THROW from a codec's `decode` — codecs here
 *     use `Error.invariant`/`TypeError.invariant` (bare `throw`, not `ctx.addIssue`),
 *     so a mismatch surfaces as EITHER `{success:false}` OR an uncaught exception;
 *     both normalize to the SAME `${name}: argument ${index} type mismatch` door.
 *  2. `z.schemeNumber` → IDENTITY. Its real decode unwraps AExact/AInexact to a raw
 *     bigint/number (and its `exact` half DOORS on non-integer rationals) — wrong for
 *     SchemeNum-role fns, which already hold a `coerceNumeric`d ANumeric. `===` is
 *     safe: `z.schemeNumber` is a module singleton.
 */
function decodeArg(name: string, index: number, schema: z.ZodTypeAny, arg: unknown): unknown {
  if ((schema as unknown) === z.schemeNumber) {
    TypeError.invariant(arg instanceof AExact || arg instanceof AInexact, `${name}: argument ${index} type mismatch`);
    return arg;
  }
  let result: { success: boolean; data?: unknown };
  try {
    result = schema.safeParse(arg);
  } catch {
    result = { success: false };
  }
  TypeError.invariant(result.success, `${name}: argument ${index} type mismatch`);
  return result.data;
}

/**
 * Encode a JS result to a scheme value via `z.encode` — the SAME `z.schemeNumber`
 * identity special case as `decodeArg`, PLUS `z.boolean`: its real encode mints a
 * fresh `ABool`, but `nativeNumericOp`'s R8 `mintVerdict` step owns that boxing (the
 * union of the CALL's operand provenance, not a single result's) — an ABool minted
 * here would be the wrong box, silently overwritten downstream.
 */
function encodeResult(schema: z.ZodTypeAny, result: unknown): unknown {
  if ((schema as unknown) === z.schemeNumber || (schema as unknown) === z.boolean) return result;
  return z.encode(schema, result as never);
}

/**
 * Raw marshalling — arity guard + per-arg schema decode + `fn` + output encode,
 * WITHOUT the provenance/coerce layer. `nativeNumericOp` runs it after coercion;
 * inline misc ops (`lcm`, `>>`, `<<`) run it too (bypass provenance); `floor/`/
 * `truncate/` skip it and call the carved fns directly.
 */
function marshalCall(name: string, spec: NumSpec, args: unknown[]): unknown {
  const { in: inSchemas, inRest, out, fn } = spec;
  const minArgs = inSchemas.length;
  TypeError.invariant(args.length >= minArgs, `${name}: expected at least ${minArgs} args, got ${args.length}`);
  TypeError.invariant(inRest || args.length <= minArgs, `${name}: expected ${minArgs} args, got ${args.length}`);
  const jsArgs = args.map((arg, i) => {
    const schema = i < inSchemas.length ? inSchemas[i] : inRest!;
    return decodeArg(name, i, schema, arg);
  });
  const jsResult = fn(...jsArgs);
  return encodeResult(out, jsResult);
}

/** Build the `(...args) => unknown` builtin for one numeric op. See file header for the three concerns. */
function nativeNumericOp(name: string, spec: NumSpec): (...args: unknown[]) => unknown {
  // provenance + coerce-with-naming + marshalled call.
  const applyNumeric = (callArgs: unknown[]): unknown => {
    // Gated on the SAME effective switch `withInputProvenance` uses
    // (`isEagerAccumulationActive` — ambient flag OR silent-region γ, op-helpers.ts's
    // own doc), so arithmetic ops honor the eager-accumulation default AND still
    // accumulate correctly inside a replay's hermetic re-execution.
    const provenance = isEagerAccumulationActive()
      ? unionProvenance(callArgs.filter((a): a is AValue => a instanceof AValue))
      : EMPTY_PROVENANCE;
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
    if (provenance.size > 0 && result instanceof AValue) return result.withProvenance(provenance);
    // R8 mint (RULINGS.md R8, op-helpers.mintVerdict): every boolean verdict boxes —
    // provenance-free operands get the eq?-stable flyweight, stamped operands a fresh
    // ABool carrying the union.
    if (typeof result === "boolean") return mintVerdict(callArgs, result);
    return result;
  };

  const fn = function (...args: unknown[]): unknown {
    return applyNumeric(args);
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

/**
 * R7RS tower-type predicates (`complex?`/`real?`/`rational?`/`integer?`/`exact?`/…/
 * `nan?`) — total over the value domain (a non-number returns #f, never an error).
 * R8 mint (op-helpers.mintVerdict): boxes + forwards `value`'s provenance —
 * `symbol.native`'s `"native"` kind binds the return raw (no codec crossing), so an
 * unboxed `boolean` would be a bare value inside the membrane (P4), not just an
 * allocation shortcut.
 */
function nativeTypePredicate(name: string, predicate: (n: ANumeric) => boolean): (...args: unknown[]) => unknown {
  const fn = (value: unknown): ABool => {
    if (!isSchemeNumber(value)) {
      return mintVerdict([value], false);
    }
    try {
      const converted = coerceNumeric(value);
      return mintVerdict([value], predicate(converted));
    } catch {
      return mintVerdict([value], false);
    }
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}


// ════════════════════════════════════════════════════════════════════════════
// Operator implementations — fn bodies.
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
// Reused op specs / cores — aliases (`**`/`%`/`==`/`|`/`&`/`~`) bind the SAME op
// object as their canonical sibling. Asymmetry: `==` binds the raw `numEqOp` core,
// canonical `=` binds it wrapped in `looseCompare` (nil-tolerant overlay) — the alias
// skips the overlay. Specs named so an alias's `symbol.native` declaration builds the
// SAME Contract shape (`contractFromSpec(spec)`) while passing the shared impl ref.
// `arithmeticShiftSpec` also consumed by `>>`/`<<` inline ops.
// ════════════════════════════════════════════════════════════════════════════

const arithmeticShiftSpec: NumSpec = { in: [z.bigint, z.integer], out: z.bigint, fn: arithmeticShiftFn };

const exptSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: schemeExpt };
const remainderSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: remainderFn };
const numEqSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: numEqFn };
const bitwiseIorSpec: NumSpec = { in: [], inRest: z.bigint, out: z.bigint, fn: bitwiseIorFn };
const bitwiseAndSpec: NumSpec = { in: [], inRest: z.bigint, out: z.bigint, fn: bitwiseAndFn };
const bitwiseNotSpec: NumSpec = { in: [z.bigint], out: z.bigint, fn: bitwiseNotFn };

const exptOp = nativeNumericOp("expt", exptSpec);
const remainderOp = nativeNumericOp("remainder", remainderSpec);
const numEqOp = nativeNumericOp("=", numEqSpec);
const bitwiseIorOp = nativeNumericOp("bitwise-ior", bitwiseIorSpec);
const bitwiseAndOp = nativeNumericOp("bitwise-and", bitwiseAndSpec);
const bitwiseNotOp = nativeNumericOp("bitwise-not", bitwiseNotSpec);

// The numeric comparison cores (provenance), wrapped by `wrapOrd`
// (FL-Ord fallback) and `looseCompare` (nil-tolerant overlay) below.
const ltSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: ltFn };
const gtSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: gtFn };
const lteSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: lteFn };
const gteSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: gteFn };

const ltOp = nativeNumericOp("<", ltSpec);
const gtOp = nativeNumericOp(">", gtSpec);
const lteOp = nativeNumericOp("<=", lteSpec);
const gteOp = nativeNumericOp(">=", gteSpec);

// ════════════════════════════════════════════════════════════════════════════
// Comparison overlay — `wrapOrd` adds FL-Ord fallback (non-numeric ordered
// entities: strings/chars/DateTime/…); `looseCompare` adds nil-tolerant overlay +
// strict-mode gate. Numbers fall through to the numeric core.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wrap a NUMERIC operator with the FL-Ord fallback. FL-Ord only intercepts NON-NUMERIC
 * ordered entities; a number falls through to `numeric(...)` (ORD_REL is a TOTAL-order
 * shortcut WRONG for the partial numeric order, and the numeric op carries provenance
 * the FL branch can't).
 */
function wrapOrd(numeric: (...a: unknown[]) => unknown, sym: "<" | ">" | "<=" | ">="): (...a: unknown[]) => unknown {
  const rel = ORD_REL[sym];
  const isOrdEntity = (x: unknown): x is AOrd => isOrd(x) && !isSchemeNumber(x);
  const fn = (...args: unknown[]): unknown => {
    if (args.length >= 2 && args.some(isOrdEntity)) {
      let verdict = true;
      for (let i = 0; i < args.length - 1; i++) {
        const a = args[i];
        const b = args[i + 1];
        if (!isOrdEntity(a) || !isOrdEntity(b)) return numeric(...args); // mixed → numeric path's clear error
        if (!rel(a, b)) {
          verdict = false;
          break;
        }
      }
      // R8 mint — the whole chain's operand union, not just the deciding pair (mirrors deriveOrd).
      return mintVerdict(args, verdict);
    }
    return numeric(...args);
  };
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

// ── Loose (nil-tolerant) comparison overlay ──────────────────────────────────────
// Base comparisons throw on nil (coerceNumeric rejects it); inference plane wants
// nil-tolerance (nil operand → #f/nil-as-bottom). Strict mode (RunContext.strict,
// off `this.runCtx`) gates loose off — an all-constant compare like `(= '() '())`
// carries no operand to thread strict, so the run ctx is the only honest source.
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
  // R8 mint — always boxed, matching applyNumeric/wrapOrd's uniform exit.
  return mintVerdict(args, verdict);
}
function looseCompare(sym, core) {
  // strict is run-CONSTANT but can't ride the operands — an all-constant compare
  // carries only CONSTANT_CTX operands. Rides the run's ctx (reconstructed onto
  // `this.runCtx` by the native-value adapter, capability.ts, at every invocation
  // path). Replaces the retired ambient `isStrict()` holder.
  const fn = function (this: CallCtx, ...args) {
    if (this.runCtx.strict === true) {
      if (!args.every(isNumberOperand))
        throw new TypeError(`${sym}: strict mode is R7RS-numeric — a non-number operand is rejected.`);
      return core(...args);
    }
    if (args.some(isNilOperand)) {
      // R8 mint — always boxed, matching looseOrderChain's uniform exit.
      if (sym === "=") return mintVerdict(args, args.every(isNilOperand));
      return looseOrderChain(sym, args);
    }
    return core(...args);
  };
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

// ════════════════════════════════════════════════════════════════════════════
// Inline misc ops — own coercion + `marshalCall` (bypass provenance layer), never
// `nativeNumericOp`.
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
const lcmSpec: NumSpec = { in: [], inRest: z.bigint, out: z.bigint, fn: lcmCoreFn };

const floorSlashFn = (n1: unknown, n2: unknown): unknown => {
  const a = coerceNumeric(n1);
  const b = coerceNumeric(n2);
  const aExact = a instanceof AExact ? a : new AExact(a.ctx, BigInt(Math.trunc(a.real)));
  const bExact = b instanceof AExact ? b : new AExact(b.ctx, BigInt(Math.trunc(b.real)));
  // Both operands AExact → floorQuotient/floorRemainder take the bothExact branch,
  // return AExact — no reconstruction.
  const q = floorQuotientFn(aExact, bExact);
  const r = floorRemainderFn(aExact, bExact);
  return Values.from([q, r]);
};

const truncateSlashFn = (n1: unknown, n2: unknown): unknown => {
  const a = coerceNumeric(n1);
  const b = coerceNumeric(n2);
  const aExact = a instanceof AExact ? a : new AExact(a.ctx, BigInt(Math.trunc(a.real)));
  const bExact = b instanceof AExact ? b : new AExact(b.ctx, BigInt(Math.trunc(b.real)));
  // Both operands AExact → truncateQuotient/truncateRemainder take the bothExact
  // branch, return AExact — no reconstruction.
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

// Boxed (RULINGS.md R1) — see NUMBER_TO_STRING_CONTRACT's doc for why a raw return
// would crash `exec`'s uniform plain-JS exit. Carries the union of the operand(s)'
// own provenance.
const numberToStringFn = (z: unknown, radix?: unknown): AString => {
  const n = coerceNumeric(z);
  const radixArg = radix === undefined ? undefined : coerceNumeric(radix);
  const base = radixArg === undefined ? 10 : Number(radixArg.valueOf());
  let s: string;
  if (n instanceof AExact) {
    s = n.denom === 1n ? n.num.toString(base) : `${n.num.toString(base)}/${n.denom.toString(base)}`;
  } else {
    // Inexact mark preservation (R7RS § 6.2): `(number->string 5.0)` must stay "5.0".
    s = base === 10 ? n.toString() : n.real.toString(base);
  }
  // Same eager-accumulation gate as `applyNumeric` above.
  const provenance = isEagerAccumulationActive()
    ? unionProvenance(radixArg === undefined ? [n] : [n, radixArg])
    : EMPTY_PROVENANCE;
  return new AString(n.ctx, s, provenance);
};

// ════════════════════════════════════════════════════════════════════════════
// `NumSpec.in`/`inRest`/`out` are the real scheme-zod.ts schemas — `contractFromSpec`
// is a trivial projection, and `marshalCall` runs the SAME schema at call time: one
// vocabulary, not two.
//
// Two arguments that still matter (honored by `marshalCall`'s `decodeArg`/
// `encodeResult`):
//
//   Decode order (coerce THEN marshal). `applyNumeric` runs `coerceNumeric` on every
//   call arg FIRST — `marshalCall`'s per-arg decode only ever sees an ANumeric. This
//   is WHY `decodeArg`'s `z.schemeNumber` identity special-case is safe: `arg` is
//   guaranteed AExact/AInexact already, never a raw scheme value.
//
//   Bool identity passthrough (R8). `out: z.boolean` positions must NOT let
//   `encodeResult` mint the ABool — `applyNumeric`'s `mintVerdict` does that AFTER
//   `marshalCall` returns, boxing the UNION of the call's operand provenance (R8),
//   not a single result's. An ABool minted inside `marshalCall` would carry no
//   provenance and be silently discarded — `encodeResult`'s `z.boolean` special case
//   exists to not do that work twice.
// ════════════════════════════════════════════════════════════════════════════

/** Map a NumSpec's schemas to a real `symbol.native` Contract — 1-tuple output
 *  (the common case). `floor/`/`truncate/`'s 2-value output and the bespoke
 *  (non-NumSpec) ops below build their Contract by hand. */
function contractFromSpec(spec: NumSpec): Contract<VectorSpec, VectorSpec, RestSpec> {
  return { input: spec.in, inputRest: spec.inRest, output: [spec.out] };
}

// ════════════════════════════════════════════════════════════════════════════
// Per-op specs — named so a `symbols` entry builds its Contract
// (`contractFromSpec(spec)`) AND its impl (`nativeNumericOp(name, spec)`) from ONE
// shared object. Every `symbols` entry below is a LITERAL `symbol.native` call.
// ════════════════════════════════════════════════════════════════════════════

const addSpec: NumSpec = { in: [], inRest: z.schemeNumber, out: z.schemeNumber, fn: addFn };
const subSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: subFn };
const mulSpec: NumSpec = { in: [], inRest: z.schemeNumber, out: z.schemeNumber, fn: mulFn };
const divSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: divFn };
const quotientSpec: NumSpec = { in: [z.bigint, z.bigint], out: z.bigint, fn: quotientFn };
const moduloSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: moduloFn };
const floorQuotientSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: floorQuotientFn };
const floorRemainderSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: floorRemainderFn };
const truncateQuotientSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: truncateQuotientFn };
const truncateRemainderSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: truncateRemainderFn };
const numeratorSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: numeratorFn };
const denominatorSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: denominatorFn };
const makeRectangularSpec: NumSpec = { in: [z.looseNumber, z.looseNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const makePolarSpec: NumSpec = { in: [z.looseNumber, z.looseNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const realPartSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const imagPartSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const magnitudeSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const angleSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const absSpec: NumSpec = { in: [z.looseAnyNumber], out: z.looseAnyNumber, fn: absFn };
const gcdSpec: NumSpec = { in: [], inRest: z.bigint, out: z.bigint, fn: gcdFn };
const maxSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: maxFn };
const minSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: minFn };
const zeroSpec: NumSpec = { in: [z.looseAnyNumber], out: z.boolean, fn: isZeroFn };
const positiveSpec: NumSpec = { in: [z.looseAnyNumber], out: z.boolean, fn: isPositiveFn };
const negativeSpec: NumSpec = { in: [z.looseAnyNumber], out: z.boolean, fn: isNegativeFn };
const oddSpec: NumSpec = { in: [z.bigint], out: z.boolean, fn: isOddFn };
const evenSpec: NumSpec = { in: [z.bigint], out: z.boolean, fn: isEvenFn };
const floorSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.floor };
const ceilingSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.ceil };
const truncateSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.trunc };
const roundSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: roundFn };
const sqrtSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: sqrtFn };
const expSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.exp };
const logSpec: NumSpec = { in: [z.looseNumber], inRest: z.looseNumber, out: z.looseNumber, fn: logFn };
const sinSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.sin };
const cosSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.cos };
const tanSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.tan };
const asinSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.asin };
const acosSpec: NumSpec = { in: [z.looseNumber], out: z.looseNumber, fn: Math.acos };
const atanSpec: NumSpec = { in: [z.looseNumber], inRest: z.looseNumber, out: z.looseNumber, fn: atanFn };
const bitwiseXorSpec: NumSpec = { in: [], inRest: z.bigint, out: z.bigint, fn: bitwiseXorFn };

// ── Bespoke contracts — ops whose impl does NOT come from `nativeNumericOp`/`NumSpec`
// (own coercion + bespoke `marshalCall` wrapper, or no NumSpec), so their Contract is
// hand-declared to match the impl's OWN JS signature (input) and narrowest return type
// (output) — never a `NumSpec` borrowed from an unrelated helper. (E.g. `lcmFn` wraps
// `lcmSpec`'s raw bigint-in/out `marshalCall` with its OWN pre/post ANumeric coercion —
// `lcmSpec` describes that INTERNAL step, not `lcmFn`'s real `(...unknown[]) => ANumeric`
// signature, so it is not reused here.) ─────────────────────────────────────────────

/** `complex?`/`real?`/`rational?`/`integer?`/`exact?`/`inexact?`/`exact-integer?`/
 *  `finite?`/`infinite?`/`nan?`/`number?` — all `(value: unknown) => boolean`, TOTAL
 *  over the value domain (never throws, a non-number is simply `#f`). Representation-
 *  blind input (matches `lists.ts`'s own convention for "genuinely could be anything"). */
const PREDICATE_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = { input: [z.value], output: [z.boolean] };

/** `floor/`/`truncate/` — `(n1: unknown, n2: unknown) => Values` of TWO scheme numbers.
 *  Input `z.schemeNumber` (not `z.value`): both impls `coerceNumeric` each operand first —
 *  the contract states the SCHEME-LEVEL domain, matching every sibling `NumSpec`-driven
 *  contract above; the wider JS-side coercion (raw bigint/number, valueOf()-able object)
 *  is an internal leniency, not a documented caller contract. */
const TWO_VALUE_OUTPUT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber, z.schemeNumber],
  output: [z.schemeNumber, z.schemeNumber],
};

/** `1+`/`1-` — `(n: unknown) => ANumeric`. Input `z.schemeNumber` (see
 *  `TWO_VALUE_OUTPUT_CONTRACT` for why). */
const ONE_ARG_NUM_OUTPUT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.schemeNumber],
};

/** `>>`/`<<` — `(a: unknown, b: unknown) => ANumeric`. `shiftRightFn`/`shiftLeftFn`
 *  `coerceNumeric` both operands before `marshalCall(arithmeticShiftSpec, …)` (which
 *  doors at runtime if not integer-shaped) — the wide `schemeNumber` is the honest
 *  declared domain; integer narrowing is `arithmeticShiftSpec`'s own runtime check. */
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

/** `inexact`/`exact->inexact` — `(z: unknown) => AInexact` (narrower than the generic
 *  scheme-number union, matching `inexactFn`'s declared return). Input `z.schemeNumber`
 *  (`inexactFn` `coerceNumeric`s first — see `TWO_VALUE_OUTPUT_CONTRACT`). */
const INEXACT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.inexact],
};

/** `exact`/`inexact->exact` — `(z: unknown) => AExact` (narrower than the generic
 *  scheme-number union, matching `exactFn`'s declared return). Input `z.schemeNumber`
 *  (`exactFn` `coerceNumeric`s first — see `TWO_VALUE_OUTPUT_CONTRACT`). */
const EXACT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.exact],
};

/** `number->string` — `(z: unknown, radix?: unknown) => AString` (boxed, carrying the
 *  union of its operands' provenance — RULINGS.md R1: `exec`'s SIMPLE tier calls `toJS`
 *  on every result, which strict-doors a raw value; a bare-JS return would crash any
 *  top-level `(number->string …)` call). The `z.string` contract's DECODED type is still
 *  `string` (it names what the value represents, not the native's return shape). Both
 *  `z`/`radix` are `z.schemeNumber` — `numberToStringFn` `coerceNumeric`s each. */
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
    // satisfy the loose `Contract<VectorSpec,VectorSpec,RestSpec>` without erasing the
    // arity first — same boundary as rosetta.ts/sequence.ts's `run` cross, cast once
    // per declaration.
    "floor/": symbol.native`floor/: floor quotient and remainder (two values)`(
      TWO_VALUE_OUTPUT_CONTRACT,
      floorSlashFn as (...args: unknown[]) => unknown,
    ),
    "truncate/": symbol.native`truncate/: truncate quotient and remainder (two values)`(
      TWO_VALUE_OUTPUT_CONTRACT,
      truncateSlashFn as (...args: unknown[]) => unknown,
    ),
    lcm: symbol.native`lcm: least common multiple (non-negative)`(LCM_CONTRACT, lcmFn),
    // R8 mint: boxes + forwards the operand's provenance (see nativeTypePredicate's doc
    // for why an unboxed native return is a P4 violation). Rest-param shape matches Impl's
    // variadic contract — no arity-erasing cast needed.
    "number?": symbol.native`number?: #t for any number`(PREDICATE_CONTRACT, (...args: unknown[]): ABool => {
      const [value] = args;
      return mintVerdict([value], isSchemeNumber(value));
    }),
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
